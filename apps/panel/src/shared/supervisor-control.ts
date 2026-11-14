import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

export type SupervisorRole = 'api' | 'worker' | 'agent';
export type SupervisorDrainStatus = 'drained' | 'uncertain' | 'timeout' | 'stopped';
export interface SupervisorControlOptions {
  role: SupervisorRole;
  socketPath: string;
  secretPath: string;
  drain: (timeoutMs: number) => Promise<{ status: SupervisorDrainStatus }>;
  signal: AbortSignal;
  reconnectMs?: number;
}

const MAX_FRAME = 4096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const roleSchema = z.enum(['api', 'worker', 'agent']);
const ackSchema = z.strictObject({version:z.literal(1),type:z.literal('hello_ack'),role:roleSchema,challenge:z.string().regex(HEX),proof:z.string().regex(HEX)});
const readySchema = z.strictObject({version:z.literal(1),type:z.literal('ready'),role:roleSchema});
const drainSchema = z.strictObject({version:z.literal(1),type:z.literal('drain'),requestId:z.string().regex(UUID),timeoutMs:z.number().int().min(1).max(60000)});

// The root-owned read-only mount and host root are a trust boundary. A node
// process cannot authenticate a Unix peer with SO_PEERCRED through Node's API.
function checkAncestors(path: string): string {
  if (process.platform !== 'linux' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error('Supervisor endpoint is not trusted');
  let part = parse(path).root;
  const components = dirname(path).slice(part.length).split('/').filter(Boolean);
  for (const component of ['', ...components]) {
    if (component) part = `${part === '/' ? '' : part}/${component}`;
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('Supervisor endpoint is not trusted');
  }
  return path;
}
function readSecret(path: string): {bytes: Buffer; dev: number; ino: number} {
  checkAncestors(path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.nlink !== 1 || (metadata.mode & 0o137) !== 0 || metadata.size < 64 || metadata.size > 65 || typeof constants.O_NOFOLLOW !== 'number') throw new Error('Supervisor secret is not trusted');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o137) !== 0 || stat.ino !== metadata.ino || stat.dev !== metadata.dev || stat.size < 64 || stat.size > 65) throw new Error('Supervisor secret is not trusted');
    const bytes = Buffer.alloc(66); let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    const value = bytes.subarray(0,count).toString('utf8');
    if (!/^[a-f0-9]{64}\n?$/.test(value) || count !== value.length) throw new Error('Supervisor secret is not trusted');
    return {bytes:Buffer.from(value.slice(0,64),'hex'),dev:stat.dev,ino:stat.ino};
  } finally { closeSync(fd); }
}
function checkSocket(path: string): {dev: number; ino: number} {
  checkAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o007) !== 0) throw new Error('Supervisor endpoint is not trusted');
  return {dev:stat.dev,ino:stat.ino};
}

// JSON.parse accepts duplicate keys. Reject duplicates before validating the schema.
function uniqueJson(text: string): unknown {
  let position = 0;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[position] ?? '\0')) position++; };
  function string(): string {
    const start = position;
    if (text[position++] !== '"') throw new Error('Invalid supervisor frame');
    while (position < text.length) {
      const char = text[position++]!;
      if (char === '"') return JSON.parse(text.slice(start, position)) as string;
      if (char === '\\') { if (position >= text.length) throw new Error('Invalid supervisor frame'); position++; }
    }
    throw new Error('Invalid supervisor frame');
  }
  function value(depth: number): unknown {
    if (depth > 8) throw new Error('Invalid supervisor frame');
    whitespace();
    if (text[position] === '"') return string();
    if (text[position] === '{') {
      position++; const result: Record<string, unknown> = Object.create(null); const keys = new Set<string>(); whitespace();
      if (text[position] === '}') {position++; return result;}
      for (;;) {
        whitespace(); const key = string(); if (keys.has(key)) throw new Error('Invalid supervisor frame'); keys.add(key);
        whitespace(); if (text[position++] !== ':') throw new Error('Invalid supervisor frame'); result[key] = value(depth + 1); whitespace();
        const separator = text[position++]; if (separator === '}') return result; if (separator !== ',') throw new Error('Invalid supervisor frame');
      }
    }
    if (text[position] === '[') {
      position++; const result: unknown[] = []; whitespace(); if (text[position] === ']') {position++; return result;}
      for (;;) {result.push(value(depth + 1)); whitespace(); const separator = text[position++]; if (separator === ']') return result; if (separator !== ',') throw new Error('Invalid supervisor frame');}
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(position));
    if (!match) throw new Error('Invalid supervisor frame'); position += match[0].length; return JSON.parse(match[0]) as unknown;
  }
  const parsed = value(0); whitespace(); if (position !== text.length) throw new Error('Invalid supervisor frame'); return parsed;
}

class FrameReader {
  private buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private wait?: {resolve: (value: unknown) => void; reject: (error: Error) => void};
  private closed = false;
  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (!this.closed) {
        const boundary = this.buffer.indexOf(10);
        if (boundary < 0) { if (this.buffer.length > MAX_FRAME) this.fail(); break; }
        if (boundary > MAX_FRAME || this.queue.length >= 2) { this.fail(); break; }
        const frame = this.buffer.subarray(0,boundary); this.buffer = this.buffer.subarray(boundary + 1);
        this.queue.push(frame); this.pump();
      }
    });
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
    socket.on('end', () => this.fail());
  }
  private fail() {
    if (this.closed) return;
    this.closed = true; this.socket.destroy();
    if (this.wait) {const pending=this.wait; this.wait=undefined; pending.reject(new Error('Supervisor connection closed'));}
  }
  private pump() {
    if (!this.wait || !this.queue.length) return;
    const pending=this.wait; this.wait=undefined; const frame=this.queue.shift()!;
    try { pending.resolve(uniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(frame))); }
    catch {pending.reject(new Error('Invalid supervisor frame')); this.fail();}
  }
  next(): Promise<unknown> {
    if (this.closed || this.wait) return Promise.reject(new Error('Supervisor connection closed'));
    return new Promise((resolvePromise,reject) => { this.wait={resolve:resolvePromise,reject}; this.pump(); });
  }
  get hasPending() { return this.queue.length > 0 || this.buffer.length > 0; }
  close() { this.fail(); }
}

function proof(secret: Buffer, direction: 'server'|'client', role: SupervisorRole, client: string, server: string): Buffer {
  return createHmac('sha256',secret).update(`servus-supervisor-${direction}-v1\0${role}\0${client}\0${server}`,'utf8').digest();
}
function send(socket: Socket, frame: object): Promise<void> {
  return new Promise((resolvePromise,reject) => {
    socket.write(`${JSON.stringify(frame)}\n`, error => error ? reject(new Error('Supervisor connection failed')) : resolvePromise());
  });
}
function deadline<T>(promise: Promise<T>, timeoutMs: number, socket: Socket): Promise<T> {
  return new Promise((resolvePromise,reject) => {
    const timer=setTimeout(() => {socket.destroy();reject(new Error('Supervisor deadline exceeded'));},timeoutMs);
    promise.then(value=>{clearTimeout(timer);resolvePromise(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
function paused(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolvePromise => {
    const finish = () => {clearTimeout(timer);signal.removeEventListener('abort',finish);resolvePromise();};
    const timer=setTimeout(finish,milliseconds);signal.addEventListener('abort',finish,{once:true});
  });
}
function resultOrClosed(socket: Socket, result: Promise<SupervisorDrainStatus>): Promise<SupervisorDrainStatus | undefined> {
  if (socket.destroyed) return Promise.resolve(undefined);
  return new Promise(resolvePromise => {
    let settled=false;
    const finish=(value: SupervisorDrainStatus | undefined) => {
      if(settled)return;settled=true;socket.removeListener('close',closed);resolvePromise(value);
    };
    const closed=()=>finish(undefined);
    socket.once('close',closed);
    result.then(value=>finish(value),()=>finish('uncertain'));
    if(socket.destroyed)finish(undefined);
  });
}
function startDrain(options: SupervisorControlOptions, timeoutMs: number): Promise<SupervisorDrainStatus> {
  return new Promise(resolvePromise => {
    let settled=false;
    const finish=(status: SupervisorDrainStatus) => {if(settled)return;settled=true;clearTimeout(timer);resolvePromise(status);};
    const timer=setTimeout(()=>finish('timeout'),timeoutMs);
    Promise.resolve().then(()=>options.drain(timeoutMs)).then(value=>{
      const status=value?.status;
      if(!['drained','uncertain','timeout','stopped'].includes(status) || (status==='stopped' && options.role!=='worker'))finish('uncertain');
      else finish(status);
    },()=>finish('uncertain'));
  });
}

/** Connect to the root-owned supervisor; this does not authorize updates or prove global quiescence. */
export async function runSupervisorControl(options: SupervisorControlOptions): Promise<void> {
  if (!roleSchema.safeParse(options.role).success || typeof options.drain !== 'function' || !options.signal || !Number.isSafeInteger(options.reconnectMs ?? 1000) || (options.reconnectMs ?? 1000) < 10 || (options.reconnectMs ?? 1000) > 60000) throw new Error('Invalid supervisor configuration');
  const secret = readSecret(options.secretPath);
  let accepted: {requestId: string; timeoutMs: number; result: Promise<SupervisorDrainStatus>} | undefined;
  const checkSecret=()=>{
    const current=readSecret(options.secretPath);
    try {
      if(current.dev!==secret.dev || current.ino!==secret.ino || !timingSafeEqual(current.bytes,secret.bytes))throw new Error('Supervisor secret changed');
    } finally {current.bytes.fill(0);}
  };
  try {
    while (!options.signal.aborted) {
      let socket: Socket | undefined;
      try {
        checkSecret();
        const expected=checkSocket(options.socketPath);
        socket=createConnection({path:options.socketPath});
        const current=socket;
        const stop=()=>current.destroy(); options.signal.addEventListener('abort',stop,{once:true});
        try {
          if(options.signal.aborted)throw new Error('Supervisor connection closed');
          const reader=new FrameReader(current);
          const until=performance.now()+5000;
          const remaining=()=>Math.max(0,until-performance.now());
          await deadline(new Promise<void>((resolvePromise,reject)=>{current.once('connect',()=>resolvePromise());current.once('error',()=>reject(new Error('Supervisor connection failed')));current.once('close',()=>reject(new Error('Supervisor connection failed')));}),remaining(),current);
          const connected=checkSocket(options.socketPath);
          if(expected.dev!==connected.dev || expected.ino!==connected.ino)throw new Error('Supervisor endpoint changed');
          checkSecret();
          const client=randomBytes(32).toString('hex'); await deadline(send(current,{version:1,type:'hello',role:options.role,challenge:client}),remaining(),current);
          const ack=ackSchema.parse(await deadline(reader.next(),remaining(),current));
          if (ack.role!==options.role || !timingSafeEqual(Buffer.from(ack.proof,'hex'),proof(secret.bytes,'server',options.role,client,ack.challenge))) throw new Error('Supervisor authentication failed');
          await deadline(send(current,{version:1,type:'hello_confirm',proof:proof(secret.bytes,'client',options.role,client,ack.challenge).toString('hex')}),remaining(),current);
          const ready=readySchema.parse(await deadline(reader.next(),remaining(),current));
          if(ready.role!==options.role)throw new Error('Supervisor authentication failed');
          const command=drainSchema.parse(await reader.next());
          if(!accepted)accepted={requestId:command.requestId,timeoutMs:command.timeoutMs,result:startDrain(options,command.timeoutMs)};
          const result=accepted.requestId===command.requestId && accepted.timeoutMs===command.timeoutMs
            ? await resultOrClosed(current,accepted.result) : 'uncertain';
          if(result===undefined)throw new Error('Supervisor disconnected during drain');
          if (reader.hasPending) throw new Error('Unexpected supervisor frame');
          if (!current.destroyed && !options.signal.aborted) await deadline(send(current,{version:1,type:'drain_result',requestId:command.requestId,status:result}),5000,current);
          reader.close();
        } finally { options.signal.removeEventListener('abort',stop); current.destroy(); }
      } catch {
        socket?.destroy();
      }
      if (!options.signal.aborted) await paused(options.signal,options.reconnectMs ?? 1000);
    }
  } finally {secret.bytes.fill(0);}
}

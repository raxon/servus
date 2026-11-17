import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalDatabaseBackupStorage } from '../../src/agent/backups.js';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture() {const directory=mkdtempSync(join(tmpdir(),'servus-backup-artifact-'));directories.push(directory);return {directory,storage:new LocalDatabaseBackupStorage(directory),id:randomUUID()};}
async function read(stream:Readable) {const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}

it('publishes a complete private artifact with its exact size and digest',async()=>{
  const {directory,storage,id}=fixture(),data=Buffer.from('synthetic database dump');
  const result=await storage.capture(id,'dump',Readable.from([data.subarray(0,5),data.subarray(5)]),data.length);
  expect(result).toEqual({extension:'dump',size:data.length,sha256:createHash('sha256').update(data).digest('hex')});
  expect(await read(storage.read(id,'dump',data.length))).toEqual(data);
  expect(statSync(join(directory,'database-backups')).mode&0o777).toBe(0o700);
  expect(statSync(join(directory,'database-backups',`${id}.dump`)).mode&0o777).toBe(0o600);
  expect(readdirSync(join(directory,'database-backups'))).toEqual([`${id}.dump`]);
});

it.each([2,4])('does not publish a short or oversized stream (declared %i)',async expected=>{
  const {directory,storage,id}=fixture();
  await expect(storage.capture(id,'sql',Readable.from(['abc']),expected)).rejects.toThrow();
  expect(readdirSync(join(directory,'database-backups'))).toEqual([]);
});

it('preserves an existing artifact when an operation identity is reused',async()=>{
  const {directory,storage,id}=fixture();await storage.capture(id,'rdb',Readable.from(['first']),5);
  await expect(storage.capture(id,'rdb',Readable.from(['second']),6)).rejects.toThrow();
  expect(readFileSync(join(directory,'database-backups',`${id}.rdb`),'utf8')).toBe('first');
});

it('refuses a symlinked directory and public directory permissions',()=>{
  const {directory}=fixture(),root=join(directory,'database-backups');rmSync(root,{recursive:true});
  const other=join(directory,'other');mkdirSync(other,{mode:0o700});symlinkSync(other,root);
  expect(()=>new LocalDatabaseBackupStorage(directory)).toThrow('private');rmSync(root);mkdirSync(root,{mode:0o755});chmodSync(root,0o755);
  expect(()=>new LocalDatabaseBackupStorage(directory)).toThrow('private');
});

it('refuses symlink and hardlink reads without following or deleting their targets',async()=>{
  const {directory,storage,id}=fixture(),root=join(directory,'database-backups'),external=join(directory,'other');writeFileSync(external,'secret',{mode:0o600});
  symlinkSync(external,join(root,`${id}.sql`));
  expect(()=>storage.read(id,'sql',6)).toThrow();expect(()=>storage.remove(id,'sql')).toThrow();
  rmSync(join(root,`${id}.sql`));linkSync(external,join(root,`${id}.sql`));
  expect(()=>storage.read(id,'sql',6)).toThrow();expect(()=>storage.remove(id,'sql')).toThrow();expect(readFileSync(external,'utf8')).toBe('secret');
});

it('does not publish after cancellation or a lost lease',async()=>{
  const {directory,storage,id}=fixture(),controller=new AbortController();controller.abort();
  await expect(storage.capture(id,'dump',Readable.from(['abc']),3,{signal:controller.signal})).rejects.toThrow();
  await expect(storage.capture(id,'dump',Readable.from(['abc']),3,{publish:()=>{throw new Error('lease lost');}})).rejects.toThrow('lease lost');
  expect(readdirSync(join(directory,'database-backups'))).toEqual([]);
});

it('rejects traversal identities and changed artifact sizes',async()=>{
  const {storage,id}=fixture();await expect(storage.capture('../escape','dump',Readable.from(['a']),1)).rejects.toThrow('identity');
  await storage.capture(id,'dump',Readable.from(['abc']),3);expect(()=>storage.read(id,'dump',4)).toThrow('metadata');
});

it('rejects same-size data corruption during a checksum-verified read',async()=>{
  const {directory,storage,id}=fixture(),captured=await storage.capture(id,'dump',Readable.from(['abc']),3);
  writeFileSync(join(directory,'database-backups',`${id}.dump`),'xyz',{mode:0o600});
  await expect(read(storage.read(id,'dump',3,captured.sha256))).rejects.toThrow('checksum');
});

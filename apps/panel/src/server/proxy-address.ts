import { timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

const secretPattern = /^[a-f0-9]{64}$/;

export function loadTrustedProxySecret(env: NodeJS.ProcessEnv): string | undefined {
  const value=env.PANEL_TRUSTED_PROXY_SECRET || undefined;
  const path=env.PANEL_TRUSTED_PROXY_SECRET_FILE;
  if(value!==undefined && path!==undefined)throw new Error('Configure only one trusted proxy secret source');
  if(path!==undefined) {
    if(!path || typeof constants.O_NOFOLLOW!=='number')throw new Error('Invalid trusted proxy secret configuration');
    let fd:number|undefined;
    try {
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const file=fstatSync(fd);
      if(!file.isFile() || (file.mode&0o077)!==0 || file.size<64 || file.size>66)throw new Error('Invalid trusted proxy secret file');
      const buffer=Buffer.alloc(67);let used=0;
      while(used<buffer.length) {const size=readSync(fd,buffer,used,buffer.length-used,null);if(size===0)break;used+=size;}
      const contents=buffer.subarray(0,used).toString('utf8');
      if(!/^[a-f0-9]{64}(?:\r?\n)?$/.test(contents))throw new Error('Invalid trusted proxy secret file');
      return contents.slice(0,64);
    } catch {throw new Error('Invalid trusted proxy secret file');}
    finally {if(fd!==undefined)closeSync(fd);}
  }
  if(value===undefined)return undefined;
  if(!secretPattern.test(value))throw new Error('Invalid trusted proxy secret configuration');
  return value;
}

export function normalizeClientAddress(value: string): string | undefined {
  if(!value || value.includes('%') || isIP(value)===0)return undefined;
  if(isIP(value)===4)return value;
  try {
    const canonical=new URL(`http://[${value}]/`).hostname.slice(1,-1);
    const mapped=canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if(mapped) {
      const high=parseInt(mapped[1]!,16),low=parseInt(mapped[2]!,16);
      return `${high>>>8}.${high&255}.${low>>>8}.${low&255}`;
    }
    return canonical;
  } catch {return undefined;}
}

export function trustedProxyRequest(req: FastifyRequest, secret: string | undefined): boolean {
  const candidate=req.headers['x-servus-proxy-secret'];
  if(!secret || typeof candidate!=='string' || !secretPattern.test(candidate))return false;
  return timingSafeEqual(Buffer.from(secret,'hex'),Buffer.from(candidate,'hex'));
}

export function clientAddress(req: FastifyRequest, secret: string | undefined): string {
  if(trustedProxyRequest(req,secret)) {
    const forwarded=req.headers['x-servus-client-ip'];
    if(typeof forwarded==='string')return normalizeClientAddress(forwarded) ?? 'invalid-trusted-address';
    return 'invalid-trusted-address';
  }
  return normalizeClientAddress(req.ip) ?? req.ip;
}

import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { AppError } from '../../src/server/errors.js';
import { registerReleaseNotes } from '../../src/server/release-notes.js';

const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of close.splice(0))await fn();});
function fixture(body:unknown,{status=200,allowed=true}={}) {
  const app=Fastify();close.push(()=>app.close());let calls=0,permitted=allowed;
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof AppError?error.statusCode:400).send({error:true}));
  registerReleaseNotes(app,{administrator:()=>{if(!permitted)throw new AppError('FORBIDDEN','Forbidden',403);},fetch:(async(url,init)=>{
    calls++;expect(String(url)).toBe('https://api.github.com/repos/raxon/servus/releases/tags/v1.2.3');expect(init?.redirect).toBe('error');
    return new Response(JSON.stringify(body),{status});
  }) as typeof fetch});
  return {app,calls:()=>calls,revoke:()=>{permitted=false;}};
}
it('returns release prose as data without treating it as HTML',async()=>{
  const {app}=fixture({tag_name:'v1.2.3',draft:false,body:'<script>injected()</script>\nChanges'});
  expect((await app.inject('/api/v1/updates/release-notes/v1.2.3')).json()).toEqual({tag:'v1.2.3',notes:'<script>injected()</script>\nChanges'});
});
it('requires administrator access before contacting GitHub',async()=>{
  const {app,calls}=fixture({}, {allowed:false});expect((await app.inject('/api/v1/updates/release-notes/v1.2.3')).statusCode).toBe(403);expect(calls()).toBe(0);
});
it('represents unpublished release notes explicitly',async()=>{
  const {app}=fixture({}, {status:404});expect((await app.inject('/api/v1/updates/release-notes/v1.2.3')).json()).toEqual({tag:'v1.2.3',notes:null});
});
it('rejects tag mismatches and drafts',async()=>{
  for(const body of [{tag_name:'v9.9.9',draft:false,body:'wrong'},{tag_name:'v1.2.3',draft:true,body:'draft'}]){
    const {app}=fixture(body);expect((await app.inject('/api/v1/updates/release-notes/v1.2.3')).statusCode).toBe(503);
  }
});
it('rejects invalid tags before fetching',async()=>{
  const {app,calls}=fixture({});expect((await app.inject('/api/v1/updates/release-notes/latest')).statusCode).toBe(400);expect(calls()).toBe(0);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from '../../src/web/api.js';

afterEach(()=>{setCsrfToken('');vi.unstubAllGlobals();});

describe('session change during a request',()=>{
  it('rejects a response from a previous account',async()=>{
    let finish!: (response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
    setCsrfToken('account-a');
    const pending=api('/projects',{method:'POST',body:{name:'project'}});
    setCsrfToken('');setCsrfToken('account-b');
    finish(new Response(JSON.stringify({id:'old-account'}),{status:200}));
    await expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
  });
  it('allows responses when a refresh preserves the current token',async()=>{
    let finish!: (response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
    setCsrfToken('same-session');
    const pending=api('/projects');
    setCsrfToken('same-session');
    finish(new Response(JSON.stringify({ok:true}),{status:200}));
    await expect(pending).resolves.toEqual({ok:true});
  });
});

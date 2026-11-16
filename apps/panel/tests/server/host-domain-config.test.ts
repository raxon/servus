import { describe, expect, it, vi } from 'vitest';
import { hostDomainOptions } from '../../src/server/host-domain-config.js';

describe('host registry configuration',()=>{
  it('automatically registers managed production installations without changing Compose',()=>{
    expect(hostDomainOptions({NODE_ENV:'production'},true,()=>({}))).toEqual({apiOrigin:'https://api.servus.run',automatic:true});
  });
  it('keeps local development and isolated supervisor fixtures manual',()=>{
    const read=vi.fn();
    expect(hostDomainOptions({},false,read)).toEqual({apiOrigin:'https://api.servus.run',automatic:false});
    expect(read).not.toHaveBeenCalled();
    expect(hostDomainOptions({},true,()=>({}))).toEqual({apiOrigin:'https://api.servus.run',automatic:false});
  });
  it('preserves the protected installation opt-out and custom registry',()=>{
    expect(hostDomainOptions({NODE_ENV:'production'},true,()=>({apiOrigin:'https://registry.example.test',automatic:false}))).toEqual({apiOrigin:'https://registry.example.test',automatic:false});
    expect(hostDomainOptions({NODE_ENV:'production'},true,()=>({apiOrigin:'',automatic:false}))).toBeUndefined();
  });
  it('supports explicit process configuration and rejects malformed settings',()=>{
    expect(hostDomainOptions({PANEL_HOST_DOMAINS_AUTOMATIC:'false'},true,()=>({automatic:true}))).toEqual({apiOrigin:'https://api.servus.run',automatic:false});
    expect(()=>hostDomainOptions({PANEL_HOST_DOMAINS_AUTOMATIC:'yes'},false)).toThrow();
    expect(()=>hostDomainOptions({},true,()=>({apiOrigin:'http://example.test'}))).toThrow();
    expect(()=>hostDomainOptions({},true,()=>({unexpected:true}))).toThrow();
  });
});

import { expect, it } from 'vitest';
import { withComposeProvider } from '../../src/agent/compose-ingress.js';

it('preserves TLS configuration and enables only explicitly marked Compose containers',()=>{
  const original=['--providers.swarm.exposedbydefault=false','--entrypoints.websecure.address=:8443','--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json'];
  const result=withComposeProvider(original);
  for(const argument of original)expect(result).toContain(argument);
  expect(result).toContain('--providers.docker.constraints=Label(`panel.compose`,`true`)');
  expect(result).toContain('--providers.docker.exposedbydefault=false');
  expect(withComposeProvider(result)).toEqual(result);
});
it('refuses to silently replace a conflicting provider security policy',()=>{
  expect(()=>withComposeProvider(['--providers.docker.exposedbydefault=true'])).toThrow('conflicting');
  expect(()=>withComposeProvider(['--providers.docker.constraints=Label(`other`,`true`)'])).toThrow('conflicting');
});

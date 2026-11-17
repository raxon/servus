import { expect, it } from 'vitest';
import { applicationUrl } from '../../src/web/application-url.js';

it('uses the public HTTPS port or configured HTTP ingress, not the container port',()=>{
  expect(applicationUrl({hostname:'app.example.com',port:3000,https:true},18080)).toBe('https://app.example.com');
  expect(applicationUrl({hostname:'app.example.com',port:3000},18080)).toBe('http://app.example.com:18080');
  expect(applicationUrl({hostname:'app.example.com',port:3000},80)).toBe('http://app.example.com');
});
it('rejects malformed domains and invalid ingress ports',()=>{
  for(const hostname of ['user@example.com','example.com/path','example.com:8080','example.com?x=1'])expect(applicationUrl({hostname,port:80},80)).toBeNull();
  expect(applicationUrl(null,80)).toBeNull();
  expect(applicationUrl({hostname:'app.example.com',port:80},0)).toBeNull();
});

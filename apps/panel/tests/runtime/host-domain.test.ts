import { afterEach, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRoutingConfiguration, installHostCertificateFiles, planHostIngress } from '../../src/agent/host-domain.js';
import { inspectHostCertificate } from '../../src/agent/host-certificate.js';
import { httpsRouteLabels } from '../../src/agent/https-routing.js';
import type { HostCertificate } from '../../src/shared/host-domain.js';

const host='1234567890abcdef.host.servus.run',directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const temporary=()=>{const value=mkdtempSync(join(tmpdir(),'host-routing-'));directories.push(value);return value;};
let certificate:HostCertificate;
beforeAll(()=>{
  const dir=mkdtempSync(join(tmpdir(),'host-tls-'));
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','60','-subj',`/CN=${host}`,'-addext',`subjectAltName=DNS:${host},DNS:*.${host}`],{stdio:'ignore'});
    const pem=readFileSync(join(dir,'cert'),'utf8');certificate={hostname:host,certificate:pem,privateKey:readFileSync(join(dir,'key'),'utf8'),expiresAt:new Date(new X509Certificate(pem).validTo).toISOString(),staging:false};
  } finally {rmSync(dir,{recursive:true,force:true});}
});
it('installs a complete TLS pair and reports its wildcard coverage without exposing the key',()=>{
  const dir=temporary();installHostCertificateFiles(dir,certificate);
  expect(inspectHostCertificate(dir,`project-app.${host}`)).toMatchObject({status:'active',expiresAt:certificate.expiresAt});
  expect(inspectHostCertificate(dir,'custom.example.test')).toBeUndefined();
  const key=readdirSync(join(dir,'host-domain','tls')).find(name=>name.endsWith('.key'))!;
  expect(statSync(join(dir,'host-domain','tls',key)).mode&0o777).toBe(0o600);
  const previous=readFileSync(join(dir,'host-domain','dynamic','host.json'),'utf8');
  expect(()=>installHostCertificateFiles(dir,{...certificate,hostname:'abcdef1234567890.host.servus.run'})).toThrow();
  expect(readFileSync(join(dir,'host-domain','dynamic','host.json'),'utf8')).toBe(previous);
});
it('rejects a symlinked certificate directory before writing through it',()=>{
  const dir=temporary(),external=temporary();symlinkSync(external,join(dir,'host-domain'));
  expect(()=>installHostCertificateFiles(dir,certificate)).toThrow('not trusted');expect(readdirSync(external)).toEqual([]);
});
it('adds a file provider idempotently and rejects foreign mounts or provider settings',()=>{
  const spec={Labels:{'panel.owner':'self-hosted-panel','panel.https':'servus-acme-v1'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:'traefik',Args:['--entrypoints.web.address=:8080','--entrypoints.websecure.address=:8443','--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json','--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web'],Mounts:[{Type:'volume',Source:'servus-acme',Target:'/letsencrypt'}]}},EndpointSpec:{Ports:[{Protocol:'tcp',PublishedPort:443,TargetPort:8443,PublishMode:'host'}]}} as import('dockerode').ServiceSpec;
  const original=structuredClone(spec),target=planHostIngress(spec,'/var/lib/servus',host);expect(spec).toEqual(original);expect(planHostIngress(target,'/var/lib/servus',host)).toEqual(target);
  const foreign=structuredClone(target);foreign.Labels!['panel.host-domain']='abcdef1234567890.host.servus.run';expect(()=>planHostIngress(foreign,'/var/lib/servus',host)).toThrow();
  const custom=structuredClone(spec);custom.TaskTemplate!.ContainerSpec!.Args!.push('--providers.file.filename=/other.json');expect(()=>planHostIngress(custom,'/var/lib/servus',host)).toThrow();
  const config=hostRoutingConfiguration(host,'a'.repeat(64));expect(config.http.routers['servus-host-https'].rule).toBe(`Host(\`${host}\`)`);expect(config.http.routers['servus-host-https'].rule).not.toContain('*');
});
it('uses the installed wildcard certificate instead of creating an ACME order for each app',()=>{
  const labels=httpsRouteLabels('64150ff3-fc4c-4c33-b79a-4821482be3c1',0,`project-app.${host}`,80,true);
  expect(Object.keys(labels).some(key=>key.endsWith('.tls.certresolver'))).toBe(false);
  expect(Object.values(labels)).toContain('true');
});

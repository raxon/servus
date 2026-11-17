import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { templateConfiguration } from '../../src/server/templates.js';
import { APPLICATION_TEMPLATES } from '../../src/shared/templates.js';
import { compileComposeDefinition, parseComposeDefinition } from '../../src/agent/compose-configuration.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'servus-templates-')),store=new Store(dataDir),actor=store.setup('admin@example.test','fixture-hash'),project=store.createProject('templates');
  const runtimeRequest=vi.fn(async(path:string,body?:{revision:number})=>path==='/compose/apply'?{state:'running',revision:body!.revision,logs:''}:{});
  const app=await createApp({dataDir,store,agentRequest:runtimeRequest as unknown as typeof agentRequest});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const session=store.createSession(actor.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'template-test'};
  return {app,store,actor,project,headers,runtimeRequest};
}

it.each(APPLICATION_TEMPLATES)('compiles the $name template with pinned images and owned persistent storage',template=>{
  const configuration=templateConfiguration(template.id,{name:'fixture'});expect(configuration.domains).toEqual([]);
  const parsed=parseComposeDefinition(configuration.source.type==='inline'?configuration.source.yaml:'');
  expect(Object.values(parsed.services).map(service=>service.image)).toEqual(template.images);
  expect(template.images.every(image=>image.includes(':')&&!image.endsWith(':latest'))).toBe(true);
  expect(Object.keys(parsed.volumes??{}).length).toBeGreaterThan(0);
  const compiled=compileComposeDefinition(parsed,configuration,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
  for(const volume of Object.values(compiled.definition.volumes) as {name:string;labels:Record<string,string>}[]) {
    expect(volume.name).toMatch(/^servus-compose-11111111111141118111111111111111_/);expect(volume.labels['panel.project']).toBe('22222222-2222-4222-8222-222222222222');
  }
  expect(JSON.stringify(parsed)).not.toMatch(/"(?:ports|privileged|pid|devices|container_name|build)":/);
});

it('keeps the WordPress database private with unique database and root passwords',()=>{
  const configuration=templateConfiguration('wordpress',{name:'website',hostname:'website.example.test'}),parsed=parseComposeDefinition(configuration.source.type==='inline'?configuration.source.yaml:'');
  const app=parsed.services.app!.environment as Record<string,string>,database=parsed.services.database!.environment as Record<string,string>;
  expect(app.WORDPRESS_DB_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(database.MARIADB_PASSWORD).toBe(app.WORDPRESS_DB_PASSWORD);expect(database.MARIADB_ROOT_PASSWORD).not.toBe(database.MARIADB_PASSWORD);
  expect(parsed.networks?.private?.internal).toBe(true);expect(configuration.domains).toEqual([{hostname:'website.example.test',service:'app',port:80,https:false}]);
});

it('generates fresh encryption and administrator secrets for independent installations',()=>{
  for(const id of ['n8n','grafana','minio'] as const) {
    const first=templateConfiguration(id,{name:'first'}),second=templateConfiguration(id,{name:'second'});
    expect(first.source).not.toEqual(second.source);
  }
});

it('supports separate MinIO console and API domains and rejects invalid combinations',()=>{
  const value=templateConfiguration('minio',{name:'store',hostname:'console.example.test',apiHostname:'s3.example.test'});
  expect(value.domains.map(domain=>domain.port)).toEqual([9001,9000]);
  expect(()=>templateConfiguration('grafana',{name:'fixture',apiHostname:'s3.example.test'})).toThrow('Only MinIO');
  expect(()=>templateConfiguration('minio',{name:'fixture',hostname:'same.example.test',apiHostname:'same.example.test'})).toThrow('different hostnames');
});

it('authenticates the catalog and returns metadata without generated configuration',async()=>{
  const {app,headers}=await fixture();expect((await app.inject({url:'/api/v1/templates'})).statusCode).toBe(401);
  const response=await app.inject({url:'/api/v1/templates',headers});expect(response.statusCode).toBe(200);expect(response.json().templates).toHaveLength(5);expect(response.payload).not.toContain('GF_SECURITY_ADMIN_PASSWORD');expect(response.payload).not.toContain('yaml');
});

it('checks CSRF and project write access before generating a workload',async()=>{
  const {app,store,project,headers}=await fixture(),url=`/api/v1/projects/${project.id}/templates/grafana`;
  expect((await app.inject({method:'POST',url,payload:{name:'dashboard'}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{name:'dashboard'}})).statusCode).toBe(403);
  const viewer=store.createUser('viewer@example.test','fixture-hash');store.addMember(project.id,viewer.id,'viewer');const session=store.createSession(viewer.id),foreign={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'viewer-template'};
  expect((await app.inject({method:'POST',url,headers:foreign,payload:{name:'dashboard'}})).statusCode).toBe(404);
  expect((store.db.prepare('SELECT count(*) AS n FROM compose_workloads').get() as {n:number}).n).toBe(0);
});

it('replays template idempotency without changing generated passwords and encrypts configuration',async()=>{
  const {app,store,project,headers}=await fixture(),url=`/api/v1/projects/${project.id}/templates/grafana`,payload={name:'dashboard'};
  const first=await app.inject({method:'POST',url,headers,payload});expect(first.statusCode).toBe(202);
  const row=store.db.prepare('SELECT configuration FROM compose_workloads WHERE id=?').get(first.json().workload.id) as {configuration:string};expect(row.configuration).toMatch(/^enc:v1:/);
  const plaintext=JSON.parse(store.vault.open(row.configuration)),parsed=parseComposeDefinition(plaintext.source.yaml),password=(parsed.services.app!.environment as Record<string,string>).GF_SECURITY_ADMIN_PASSWORD;
  expect(first.payload).not.toContain(password);expect(first.payload).not.toContain('yaml');
  const repeated=await app.inject({method:'POST',url,headers,payload});expect(repeated.statusCode).toBe(202);expect(repeated.json().workload.id).toBe(first.json().workload.id);expect(repeated.json().action.id).toBe(first.json().action.id);
  expect((store.db.prepare('SELECT configuration FROM compose_workloads WHERE id=?').get(first.json().workload.id) as {configuration:string}).configuration).toBe(row.configuration);
  expect((await app.inject({method:'POST',url,headers,payload:{...payload,hostname:'changed.example.test'}})).statusCode).toBe(409);
  expect((await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/templates/n8n`,headers,payload})).statusCode).toBe(409);
});

it('queues each catalog template through the shared Compose implementation',async()=>{
  const {app,project,headers}=await fixture();
  for(const template of APPLICATION_TEMPLATES) {
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/templates/${template.id}`,headers:{...headers,'idempotency-key':template.id},payload:{name:template.id}});
    expect(response.statusCode).toBe(202);expect(response.json().workload.sourceType).toBe('inline');expect(response.json().action.type).toBe('deploy');expect(response.json().workload.domains).toEqual([]);
  }
});

it('rejects unknown templates, unsupported fields and injected hostnames',async()=>{
  const {app,project,headers}=await fixture(),base=`/api/v1/projects/${project.id}/templates`;
  expect((await app.inject({method:'POST',url:`${base}/unknown`,headers,payload:{name:'fixture'}})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:`${base}/wordpress`,headers,payload:{name:'fixture',yaml:'arbitrary'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`${base}/wordpress`,headers,payload:{name:'fixture',hostname:'x`) || Host(`other'}})).statusCode).toBe(400);
});

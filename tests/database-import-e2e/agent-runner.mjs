import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Docker from '/app/node_modules/dockerode/lib/docker.js';
import { Store } from '/app/dist/server/store.js';
import { createAgent } from '/app/dist/agent/app.js';

const dataDir = mkdtempSync('/tmp/restore-agent-e2e-'), store = new Store(dataDir);
const serviceId = '11111111-1111-4111-8111-111111111111', kind = process.env.SERVUS_IMPORT_KIND;
const operationId = process.env.SERVUS_IMPORT_OPERATION, password = readFileSync('/fixture-password','utf8');
const actor = store.setup('fixture@example.test','fixture-hash'), project = store.createProject('restore-fixture');
const now = new Date().toISOString(), actionId = randomUUID(), jobId = randomUUID();
store.db.prepare(`INSERT INTO services(id,project_id,name,image,port,hostname,replicas,revision,deployed_revision,state,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1,'running',NULL,?,?)`)
  .run(serviceId,project.id,'fixture','fixture:latest',kind === 'postgres' ? 5432 : 3306,'fixture.internal',now,now);
const reference = store.vault.put(password);
store.db.prepare("INSERT INTO service_secret_refs(reference,service_id,purpose) VALUES(?,?,'database')").run(reference,serviceId);
const snapshot = {id:serviceId,projectId:project.id,kind,database:{database:'fixture',user:'fixture',passwordSecretRef:reference}};
store.db.prepare("INSERT INTO actions VALUES(?,?,?,?,?,'succeeded','complete',NULL,?,?,?)").run(actionId,project.id,serviceId,actor.id,'deploy',now,now,now);
store.db.prepare("INSERT INTO jobs(id,action_id,service_id,snapshot,status,created_at) VALUES(?,?,?,?,'succeeded',?)").run(jobId,actionId,serviceId,JSON.stringify(snapshot),now);
if (kind === 'mariadb') {
  const directory = join(dataDir,'database-roots'); mkdirSync(directory,{mode:0o700});
  writeFileSync(join(directory,serviceId),store.vault.put(password),{mode:0o600});
}
const docker = new Docker({socketPath:'/var/run/docker.sock'});
const runtime = {status:async()=>({online:true}),inspectService:async()=>({state:'running'}),apply:async()=>{throw new Error('Unexpected mutation');},consoleContainer:async()=>docker.getContainer(process.env.SERVUS_IMPORT_SOURCE_ID)};
const token = 'fixture-agent-token';
const agent = await createAgent({dataDir,token,socketPath:join(dataDir,'socket'),dockerSocket:'/var/run/docker.sock',ingressPort:18080,ingressImage:'unused'},runtime);
const headers = {authorization:`Bearer ${token}`};
const path = `/services/${serviceId}/database-restore/${operationId}`;
try {
  const upload = await agent.inject({method:'POST',url:`/services/${serviceId}/database-restore/upload?operationId=${operationId}&kind=${kind}`,headers:{...headers,'content-type':'application/octet-stream'},payload:readFileSync('/fixture-data')});
  if (upload.statusCode !== 200 || upload.json().phase !== 'reserved') throw new Error(`Upload failed: ${upload.statusCode}`);
  const prepared = await agent.inject({method:'POST',url:`${path}/prepare`,headers,payload:{}});
  if (prepared.statusCode !== 200 || prepared.json().phase !== 'prepared') throw new Error(`Preparation failed: ${prepared.statusCode} ${JSON.stringify(prepared.json())}`);
  const status = await agent.inject({method:'GET',url:path,headers});
  if (status.statusCode !== 200 || status.json().phase !== 'prepared') throw new Error('Prepared state was not recorded');
} finally { await agent.close(); store.close(); rmSync(dataDir,{recursive:true,force:true}); }

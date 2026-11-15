import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Docker from '/app/node_modules/dockerode/lib/docker.js';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { Store } from '/app/dist/server/store.js';
import { createAgent } from '/app/dist/agent/app.js';
import { RestoreJournal } from '/app/dist/agent/restore-journal.js';
import { prepareRestoreSwitchIntent, readRestoreSwitchIntent } from '/app/dist/agent/restore-switch-intent.js';
import { applyRestoreSwitch } from '/app/dist/agent/restore-switch-apply.js';
import { rollbackRestoreSwitch } from '/app/dist/agent/restore-switch-rollback.js';
import { finalizeRestoreRollback } from '/app/dist/agent/restore-rollback-finalize.js';

const dataDir = mkdtempSync('/tmp/restore-agent-e2e-'), store = new Store(dataDir);
const serviceId = process.env.SERVUS_IMPORT_SERVICE_ID || '11111111-1111-4111-8111-111111111111', kind = process.env.SERVUS_IMPORT_KIND;
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
let switchDb, switchPlan, switchOptions;
try {
  const upload = await agent.inject({method:'POST',url:`/services/${serviceId}/database-restore/upload?operationId=${operationId}&kind=${kind}`,headers:{...headers,'content-type':'application/octet-stream'},payload:readFileSync('/fixture-data')});
  if (upload.statusCode !== 200 || upload.json().phase !== 'reserved') throw new Error(`Upload failed: ${upload.statusCode}`);
  const prepared = await agent.inject({method:'POST',url:`${path}/prepare`,headers,payload:{}});
  if (prepared.statusCode !== 200 || prepared.json().phase !== 'prepared') throw new Error(`Preparation failed: ${prepared.statusCode} ${JSON.stringify(prepared.json())}`);
  const status = await agent.inject({method:'GET',url:path,headers});
  if (status.statusCode !== 200 || status.json().phase !== 'prepared') throw new Error('Prepared state was not recorded');
  if (process.env.SERVUS_SWITCH_INSPECT === '1') {
    const inspection = await agent.inject({method:'GET',url:`${path}/switch-inspection`,headers});
    if (inspection.statusCode !== 200 || inspection.json().sourceContainerId !== process.env.SERVUS_IMPORT_SOURCE_ID || inspection.json().sourceVolume !== `panel-data-${serviceId}-database` || inspection.json().candidateVolume !== `panel-restore-${operationId}`) throw new Error(`Switch inspection failed: ${inspection.statusCode} ${JSON.stringify(inspection.json())}`);
  }
  const query = kind === 'postgres'
    ? 'PGPASSWORD="$(cat /run/secrets/panel-db-password)" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"'
    : 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"';
  if (execFileSync('docker',['exec',`panel-restore-${operationId}`,'sh','-c',query],{encoding:'utf8',env:{...process.env,PATH:`${process.env.PATH}:/usr/local/bin`}}).trim() !== 'expected-marker') throw new Error('Candidate data does not match');
  if (process.env.SERVUS_SWITCH_APPLY === '1') {
    switchDb=new Database(join(dataDir,'agent.sqlite'));const journal=new RestoreJournal(switchDb,()=>false);
    const options={docker,journal,vault:store.vault,serviceId,operationId};switchOptions=options;
    await prepareRestoreSwitchIntent(options);switchPlan=readRestoreSwitchIntent(options);
    const verifyTarget=async plan=>{
      for(let attempt=0;attempt<90;attempt++) {
        const containers=await docker.listContainers({all:true,filters:{volume:[plan.inspection.candidateVolume]}});
        for(const item of containers) {
          const info=await docker.getContainer(item.Id).inspect();
          if(!info.State.Running||info.Config.Labels?.['com.docker.swarm.service.name']!==`panel-app-${serviceId}`)continue;
          const sourceQuery=kind==='postgres'?'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"':'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"';
          try {if(execFileSync('docker',['exec',item.Id,'sh','-c',sourceQuery],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env:{...process.env,PATH:`${process.env.PATH}:/usr/local/bin`}}).trim()==='expected-marker')return;}catch{}
        }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw new Error('Switched database did not become ready');
    };
    await applyRestoreSwitch({...options,verifyTarget});
    if(journal.switchIntent(operationId)?.stage!=='applied'||!journal.hasUnresolved(serviceId))throw new Error('Switch is not durably fenced');
  } else {
    for (let attempt=0;attempt<2;attempt++) {
      const cancelled = await agent.inject({method:'POST',url:`${path}/cancel`,headers,payload:{}});
      if (cancelled.statusCode !== 200 || cancelled.json().phase !== 'cancelled') throw new Error(`Cancellation failed: ${cancelled.statusCode} ${JSON.stringify(cancelled.json())}`);
    }
  }
} finally {
  if(switchPlan){
    const verifySource=async plan=>{
      for(let attempt=0;attempt<90;attempt++){
        const active=await docker.listContainers({all:true,filters:{volume:[plan.inspection.sourceVolume]}});
        for(const item of active){
          const info=await docker.getContainer(item.Id).inspect();
          if(!info.State.Running||info.Config.Labels?.['com.docker.swarm.service.name']!==`panel-app-${serviceId}`)continue;
          const sourceQuery=kind==='postgres'?`PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT string_agg(value, ',' ORDER BY value) FROM items"`:`MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT GROUP_CONCAT(value ORDER BY value SEPARATOR ',') FROM items"`;
          try{if(execFileSync('docker',['exec',item.Id,'sh','-c',sourceQuery],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env:{...process.env,PATH:`${process.env.PATH}:/usr/local/bin`}}).trim()==='expected-marker,source-after-backup')return;}catch{}
        }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw new Error('Original database did not become ready');
    };
    await rollbackRestoreSwitch({...switchOptions,verifySource});
    if(switchOptions.journal.switchIntent(operationId)?.stage!=='rolled_back')throw new Error('Rollback was not recorded');
    await rollbackRestoreSwitch({...switchOptions,verifySource});
    const finished=await finalizeRestoreRollback({...switchOptions,dataDir,verifySource});
    if(finished.phase!=='cancelled'||switchOptions.journal.hasUnresolved(serviceId)||switchOptions.journal.retainedVolume(operationId)?.volume_name!==switchPlan.inspection.candidateVolume)throw new Error('Rollback retention was not recorded');
    await docker.getVolume(switchPlan.inspection.candidateVolume).inspect();
    await finalizeRestoreRollback({...switchOptions,dataDir,verifySource});
  }
  switchDb?.close();await agent.close(); store.close(); rmSync(dataDir,{recursive:true,force:true});
}

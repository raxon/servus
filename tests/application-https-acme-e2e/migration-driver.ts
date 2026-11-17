// Runs only against the explicitly selected disposable Colima test profile.
import Docker from 'dockerode';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';
import { SecretVault } from '../../apps/panel/src/shared/secrets.js';
import { HttpsMigrationJournal } from '../../apps/panel/src/agent/https-migration-journal.js';
import { dockerIngressMigrationDriver } from '../../apps/panel/src/agent/https-migration-docker.js';
import { applyHttpsMigration, recoverHttpsMigration } from '../../apps/panel/src/agent/https-migration.js';

const socket=process.env.HOME+'/.colima/servus-https-e2e/docker.sock';
if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Disposable test environment must be explicitly selected.');
const docker=new Docker({socketPath:socket});
const info=await docker.info();
if(info.Name!=='colima-servus-https-e2e')throw new Error('Unexpected Docker host.');
const name='servus-migration-driver-test';
const dir=mkdtempSync(join(tmpdir(),'servus-ingress-test-'));
const db=new Database(join(dir,'agent.sqlite'));
db.exec("CREATE TABLE operations (id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL,response TEXT,updated_at TEXT NOT NULL,previous_spec TEXT,previous_recorded INTEGER NOT NULL DEFAULT 0,target_spec TEXT,operation_stage TEXT NOT NULL DEFAULT 'applying',previous_error TEXT,service_id TEXT)");
const vault=new SecretVault(dir),journal=new HttpsMigrationJournal(db,value=>vault.seal(value),value=>vault.open(value));
const driver=dockerIngressMigrationDriver(docker,name,60_000);
let service:Docker.Service|undefined;
try {
  service=await docker.createService({Name:name,Labels:{'panel.owner':'disposable-test'},TaskTemplate:{ContainerSpec:{Image:'traefik:3.7.13',Args:['--entrypoints.web.address=:8080']},RestartPolicy:{Condition:'any'}},Mode:{Replicated:{Replicas:1}}});
  const first=await driver.inspect();await driver.waitHealthy(first.spec);
  const target=structuredClone(first.spec);
  target.TaskTemplate!.ContainerSpec!.Args!.push('--log.level=DEBUG');
  target.UpdateConfig={...target.UpdateConfig,Order:'stop-first',FailureAction:'rollback',Parallelism:1,MaxFailureRatio:0};
  await applyHttpsMigration(journal,driver,first.spec,target,first.version);
  assert.deepEqual((await driver.inspect()).spec,target);
  // Simulate process death after Swarm accepted the update but before commit.
  const current=await driver.inspect();
  journal.begin(target,first.spec);
  await driver.update(first.spec,current.version);
  await recoverHttpsMigration(journal,driver);
  assert.deepEqual((await driver.inspect()).spec,target);
  assert.equal(journal.load(),undefined);
  console.log('Docker ingress migration and crash recovery passed.');
} finally {
  if(service)await service.remove();
  db.close();rmSync(dir,{recursive:true,force:true});
}

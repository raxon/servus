import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks=vi.hoisted(()=>({inspect:vi.fn()}));
vi.mock('../../src/agent/restore-switch-inspect.js',()=>({inspectRestoreSwitch:mocks.inspect}));
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { SecretVault } from '../../src/shared/secrets.js';
import { prepareRestoreSwitchIntent, readRestoreSwitchIntent } from '../../src/agent/restore-switch-intent.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const remove of cleanup.splice(0).reverse())remove();vi.resetAllMocks();});
function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'restore-switch-intent-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const path=join(dataDir,'agent.sqlite'),db=new Database(path);cleanup.push(()=>{if(db.open)db.close();});
  db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');
  const journal=new RestoreJournal(db,()=>false),vault=new SecretVault(dataDir),serviceId=randomUUID(),operationId='a'.repeat(32);
  journal.reserve({id:operationId,serviceId,kind:'postgres',archiveSha256:'b'.repeat(64)});journal.advance(operationId,'reserved','importing');journal.advance(operationId,'importing','prepared');
  const inspection={serviceId,operationId,serviceDockerId:'swarm-service',serviceVersion:12,sourceContainerId:'c'.repeat(64),sourceVolume:`panel-data-${serviceId}-database`,candidateContainerId:'d'.repeat(64),candidateVolume:`panel-restore-${operationId}`,imageId:`sha256:${'e'.repeat(64)}`,nodeId:'node'};
  const spec={Name:`panel-app-${serviceId}`,Labels:{'panel.owner':'self-hosted-panel'},TaskTemplate:{ContainerSpec:{Env:['FIXTURE_SECRET=private-value'],Mounts:[{Type:'volume',Source:inspection.sourceVolume,Target:'/var/lib/postgresql/data'}]}}};
  const service={ID:inspection.serviceDockerId,Version:{Index:12},Spec:spec};
  const docker={getService:()=>({inspect:async()=>service})};mocks.inspect.mockResolvedValue(inspection);
  return {db,path,journal,vault,service,spec,inspection,options:{docker:docker as never,journal,vault,serviceId,operationId}};
}

it('atomically records encrypted previous and target specs before changing the journal phase',async()=>{
  const f=fixture();expect(await prepareRestoreSwitchIntent(f.options)).toEqual(f.inspection);
  expect(f.journal.get(f.options.operationId)?.phase).toBe('switching');
  const stored=f.journal.switchIntent(f.options.operationId)!;
  expect(stored.sealed_plan).not.toContain('private-value');
  const plan=readRestoreSwitchIntent(f.options);
  expect(plan.previousSpec.TaskTemplate?.ContainerSpec?.Mounts?.[0]?.Source).toBe(f.inspection.sourceVolume);
  expect(plan.targetSpec.TaskTemplate?.ContainerSpec?.Mounts?.[0]?.Source).toBe(f.inspection.candidateVolume);
  expect(f.spec.TaskTemplate.ContainerSpec.Mounts[0]!.Source).toBe(f.inspection.sourceVolume);
  expect(()=>f.journal.advance(f.options.operationId,'prepared','switching')).toThrow('transition');
});

it('recovers the authenticated plan after reopening the journal',async()=>{
  const f=fixture();await prepareRestoreSwitchIntent(f.options);f.db.close();
  const reopened=new Database(f.path);cleanup.push(()=>reopened.close());
  const journal=new RestoreJournal(reopened,()=>false),vault=new SecretVault(join(f.path,'..'));
  const plan=readRestoreSwitchIntent({...f.options,journal,vault});
  expect(plan.inspection).toEqual(f.inspection);expect(journal.hasUnresolved(f.options.serviceId)).toBe(true);
});

it('rejects a changed service before fencing the operation',async()=>{
  const f=fixture();f.service.Version.Index=13;
  await expect(prepareRestoreSwitchIntent(f.options)).rejects.toThrow('changed');
  expect(f.journal.get(f.options.operationId)?.phase).toBe('prepared');expect(f.journal.switchIntent(f.options.operationId)).toBeUndefined();
});

it('rolls back the phase change when writing the intent fails',async()=>{
  const f=fixture();f.db.exec("CREATE TRIGGER fail_switch BEFORE INSERT ON restore_switch_intents BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await expect(prepareRestoreSwitchIntent(f.options)).rejects.toThrow('synthetic failure');
  expect(f.journal.get(f.options.operationId)?.phase).toBe('prepared');expect(f.journal.switchIntent(f.options.operationId)).toBeUndefined();
});

it('rejects a corrupted encrypted plan',async()=>{
  const f=fixture();await prepareRestoreSwitchIntent(f.options);
  const sealed=f.journal.switchIntent(f.options.operationId)!.sealed_plan;
  f.db.prepare('UPDATE restore_switch_intents SET sealed_plan=? WHERE id=?').run(sealed.slice(0,-8)+'AAAAAAAA',f.options.operationId);
  expect(()=>readRestoreSwitchIntent(f.options)).toThrow();expect(f.journal.hasUnresolved(f.options.serviceId)).toBe(true);
});

it('migrates an existing switch journal without losing its in-progress stage',async()=>{
  const f=fixture();await prepareRestoreSwitchIntent(f.options);
  f.journal.advanceSwitchStage(f.options.operationId,'pending','candidate_stop');
  f.db.exec("ALTER TABLE restore_switch_intents RENAME TO new_switch; CREATE TABLE restore_switch_intents(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,service_version INTEGER NOT NULL,sealed_plan TEXT NOT NULL,created_at TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('pending','candidate_stop','candidate_detached','applying','applied'))); INSERT INTO restore_switch_intents SELECT * FROM new_switch; DROP TABLE new_switch");
  const migrated=new RestoreJournal(f.db,()=>false);
  expect(migrated.switchIntent(f.options.operationId)?.stage).toBe('candidate_stop');
  expect(migrated.advanceSwitchStage(f.options.operationId,'candidate_stop','rolling_back').stage).toBe('rolling_back');
});

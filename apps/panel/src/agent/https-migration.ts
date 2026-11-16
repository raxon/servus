import { isDeepStrictEqual } from 'node:util';
import type { ServiceSpec } from 'dockerode';
import { HttpsMigrationJournal } from './https-migration-journal.js';

/** Docker adapter must inspect the current version and reject stale updates. */
export type IngressMigrationDriver = {
  inspect():Promise<{spec:ServiceSpec;version:number}>;
  update(spec:ServiceSpec,version:number):Promise<void>;
  waitHealthy(expected:ServiceSpec):Promise<void>;
};

/** Recovery always favours restoring the recorded HTTP ingress over guessing success. */
export async function recoverHttpsMigration(journal:HttpsMigrationJournal,driver:IngressMigrationDriver):Promise<void> {
  let intent=journal.load();
  if(!intent)return;
  if(intent.stage==='applying'){journal.rollback();intent=journal.load()!;}
  const current=await driver.inspect();
  if(isDeepStrictEqual(current.spec,intent.target))await driver.update(intent.previous,current.version);
  else if(!isDeepStrictEqual(current.spec,intent.previous))throw new Error('Ingress changed independently; automatic recovery requires review.');
  await driver.waitHealthy(intent.previous);
  const verified=await driver.inspect();
  if(!isDeepStrictEqual(verified.spec,intent.previous))throw new Error('Ingress changed during recovery; recovery remains pending.');
  journal.finish('restored');
}

export async function applyHttpsMigration(journal:HttpsMigrationJournal,driver:IngressMigrationDriver,previous:ServiceSpec,target:ServiceSpec,version:number):Promise<void> {
  journal.begin(previous,target);
  try {
    await driver.update(target,version);
    await driver.waitHealthy(target);
    const verified=await driver.inspect();
    if(!isDeepStrictEqual(verified.spec,target))throw new Error('Ingress changed during migration.');
    journal.finish('applied');
  } catch(error) {
    try { await recoverHttpsMigration(journal,driver); }
    catch(recoveryError) { throw new AggregateError([error,recoveryError],'HTTPS ingress migration failed and recovery remains pending.'); }
    throw error;
  }
}

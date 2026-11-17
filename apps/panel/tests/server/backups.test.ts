import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { DatabaseBackups } from '../../src/server/backups.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import { MaintenanceGate } from '../../src/server/maintenance.js';
import { backupCronMatches, describeBackupCron, parseBackupCron } from '../../src/shared/backups.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
function exported(data:string,extension='dump',length=data.length) {return Object.assign(Readable.from([data]),{headers:{'content-length':String(length),'x-export-extension':extension}}) as IncomingMessage;}
function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'servus-backup-manager-')),store=new Store(dataDir),actor=store.setup('admin@example.test','irrelevant-hash'),project=store.createProject('backup-test');
  const {service:created}=store.createService(project.id,normalizeServiceInput({name:'database',kind:'postgres'}),actor.id);
  const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const service=store.getService(created.id)!;
  let clock=new Date('2026-11-17T01:00:00.000Z');
  const databaseExport=vi.fn(async()=>exported('database-content')),maintenance=new MaintenanceGate();
  const backups=new DatabaseBackups({store,databaseExport,maintenance,now:()=>clock,serviceAccess:()=>{throw new Error('Unused');}});
  cleanups.push(async()=>{await backups.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {store,actor,project,service,backups,databaseExport,maintenance,dataDir,setTime:(date:string)=>{clock=new Date(date);}};
}

it('creates one durable idempotent manual backup and preserves its name',async()=>{
  const {backups,actor,service,databaseExport}=fixture();
  const first=backups.create(service,actor,{name:'Before migration'},'manual-1');
  expect(backups.create(service,actor,{name:'Before migration'},'manual-1').id).toBe(first.id);
  expect(()=>backups.create(service,actor,{name:'Different'},'manual-1')).toThrow('different backup');
  await backups.drain();
  const result=backups.list(service.id)[0]!;expect(result).toMatchObject({name:'Before migration',status:'succeeded',trigger:'manual',size:16,extension:'dump'});expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  const artifact=await backups.read(service.id,result.id);const chunks=[];for await(const chunk of artifact.stream)chunks.push(chunk);expect(Buffer.concat(chunks).toString()).toBe('database-content');
  expect(databaseExport).toHaveBeenCalledTimes(1);
});

it('allows only one pending backup per database',async()=>{
  const {backups,actor,service,databaseExport}=fixture(),input=new PassThrough();
  databaseExport.mockResolvedValueOnce(Object.assign(input,{headers:{'content-length':'3','x-export-extension':'dump'}}) as IncomingMessage);
  backups.create(service,actor,{},'first');
  expect(()=>backups.create(service,actor,{},'second')).toThrow('already queued or running');
  input.end('abc');await backups.drain();expect(backups.list(service.id)[0]!.status).toBe('succeeded');
});

it('keeps only the configured completed backups and never purges after failure',async()=>{
  const {backups,actor,service,setTime,databaseExport}=fixture();backups.saveSettings(service,actor,{enabled:false,cron:'0 2 * * *',retention:1});
  backups.create(service,actor,{name:'first'},'first');await backups.drain();
  setTime('2026-11-17T01:01:00.000Z');databaseExport.mockResolvedValueOnce(exported('short','dump',10));backups.create(service,actor,{name:'failed'},'failed');await backups.drain();
  expect(backups.list(service.id).find(backup=>backup.name==='first')!.status).toBe('succeeded');
  setTime('2026-11-17T01:02:00.000Z');backups.create(service,actor,{name:'last'},'last');await backups.drain();
  expect(backups.list(service.id).find(backup=>backup.name==='first')!.status).toBe('deleted');expect(backups.list(service.id).find(backup=>backup.name==='last')!.status).toBe('succeeded');
});

it('runs schedules once per UTC minute and does not replay missed minutes',async()=>{
  const {backups,actor,service,setTime,databaseExport}=fixture();backups.saveSettings(service,actor,{enabled:true,cron:'* * * * *',retention:7});
  backups.tick();expect(databaseExport).not.toHaveBeenCalled();
  setTime('2026-11-17T01:01:00.000Z');backups.tick();backups.tick();await backups.drain();expect(databaseExport).toHaveBeenCalledTimes(1);
  setTime('2026-11-17T02:15:00.000Z');backups.tick();await backups.drain();expect(databaseExport).toHaveBeenCalledTimes(2);
});

it('does not run schedules after their owner loses project write access',async()=>{
  const {backups,service,store,project,setTime,databaseExport}=fixture();
  const member=store.createUser('member@example.test','irrelevant-hash');store.addMember(project.id,member.id,'editor');backups.saveSettings(service,member,{enabled:true,cron:'* * * * *',retention:7});
  store.addMember(project.id,member.id,'viewer');setTime('2026-11-17T01:01:00.000Z');backups.tick();await backups.drain();expect(databaseExport).not.toHaveBeenCalled();expect(backups.settings(service.id).enabled).toBe(false);
});

it('reports retention failure while keeping the new successful backup downloadable',async()=>{
  const {backups,actor,service,setTime,dataDir}=fixture();backups.saveSettings(service,actor,{enabled:false,cron:'0 2 * * *',retention:1});
  const first=backups.create(service,actor,{},'first');await backups.drain();
  chmodSync(join(dataDir,'database-backups',`${first.id}.dump`),0o644);
  setTime('2026-11-17T01:02:00.000Z');const next=backups.create(service,actor,{},'last');await backups.drain();
  expect(backups.list(service.id).find(backup=>backup.id===next.id)).toMatchObject({status:'succeeded',error:'Backup completed, but older backups could not be removed. Check backup storage permissions.'});
  const {stream}=await backups.read(service.id,next.id);stream.destroy();
});

it('rejects invalid schedules, sub-minute expressions and missing idempotency keys',()=>{
  const {backups,actor,service}=fixture();
  for(const cron of ['* * * * * *','60 * * * *','*/0 * * * *','0 0 0 * *','@daily','0 0 * * MON'])expect(()=>backups.saveSettings(service,actor,{enabled:true,cron,retention:7})).toThrow();
  expect(()=>backups.create(service,actor,{},undefined)).toThrow('Idempotency-Key');
});

it('marks expired foreign work failed but preserves fresh leases',()=>{
  const {backups,actor,service,store,setTime}=fixture();
  const stamp='2026-11-17T01:00:00.000Z';
  store.db.prepare(`INSERT INTO database_backups (id,service_id,actor_id,name,status,trigger,idempotency_key,request_hash,created_at,owner_id,lease_until) VALUES (?,?,?,'orphan','running','manual','manual:orphan','hash',?,'old-process',?)`).run('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',service.id,actor.id,stamp,'2026-11-17T01:15:00.000Z');
  backups.tick();expect(backups.list(service.id)[0]!.status).toBe('running');
  setTime('2026-11-17T01:16:00.000Z');backups.tick();expect(backups.list(service.id)[0]!).toMatchObject({status:'failed',error:'Backup interrupted before completion. Create a new backup.'});
});

it('drains active backup work and refuses to start during maintenance',async()=>{
  const {backups,actor,service,maintenance,databaseExport}=fixture(),input=new PassThrough();
  databaseExport.mockResolvedValueOnce(Object.assign(input,{headers:{'content-length':'3','x-export-extension':'dump'}}) as IncomingMessage);
  backups.create(service,actor,{},'first');await Promise.resolve();
  const draining=maintenance.drain(1000);input.end('abc');await backups.drain();expect(await draining).toEqual({status:'drained'});
  const queued=backups.create(service,actor,{},'second');expect(backups.list(service.id).find(backup=>backup.id===queued.id)!.status).toBe('queued');expect(databaseExport).toHaveBeenCalledTimes(1);
});

it('persists failed results without source errors or partial artifacts',async()=>{
  const {backups,actor,service,databaseExport,dataDir}=fixture();databaseExport.mockRejectedValueOnce(new Error('password=SYNTHETIC-SECRET'));
  backups.create(service,actor,{},'failed');await backups.drain();
  expect(JSON.stringify(backups.list(service.id))).not.toContain('SYNTHETIC-SECRET');expect(backups.list(service.id)[0]!.status).toBe('failed');expect(readdirSync(join(dataDir,'database-backups'))).toEqual([]);
});

it('never downloads or deletes another database backup through a guessed identity',async()=>{
  const {backups,actor,service}=fixture();const created=backups.create(service,actor,{},'own');await backups.drain();
  await expect(backups.read('another-service',created.id)).rejects.toThrow('not found');await expect(backups.remove('another-service',created.id,actor)).rejects.toThrow('not found');
});

it('parses standard numeric cron ranges, lists and steps with UTC day semantics',()=>{
  expect(describeBackupCron('0 2 * * *')).toBe('Every day at 02:00 UTC');expect(describeBackupCron('*/5 * * * *')).toBe('Every 5 minutes (UTC)');
  expect(backupCronMatches('0,30 1-3 * * 1-5',new Date('2026-11-17T01:30:00Z'))).toBe(true);
  expect(backupCronMatches('0 2 * * 7',new Date('2026-11-22T02:00:00Z'))).toBe(true);
  expect(backupCronMatches('0 2 17 * 0',new Date('2026-11-17T02:00:00Z'))).toBe(true);
  expect(backupCronMatches('0 2 17 * 0',new Date('2026-11-22T02:00:00Z'))).toBe(true);
  expect(backupCronMatches('0 2 * * *',new Date('2026-11-17T02:01:00Z'))).toBe(false);
  expect(()=>parseBackupCron('0 0 1 13 *')).toThrow('range');
});

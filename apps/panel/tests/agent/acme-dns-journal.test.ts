import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { DnsChallengeJournal } from '../../src/agent/acme/dns-journal.js';
import { ManualDns01Provider } from '../../src/agent/acme/manual.js';
import { observeDns01 } from '../../src/agent/acme/dns-observation.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'servus-dns-journal-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const db=new Database(join(dir,'agent.sqlite'));db.pragma('journal_mode=WAL');cleanup.push(()=>{if(db.open)db.close();});return {dir,db};}
function challenge(){return {operationId:'a'.repeat(32),identifier:'*.Example.com',value:Buffer.alloc(32,9).toString('base64url')};}

it('refuses schema creation until the host compatibility gate is supplied',()=>{
  const {db}=fixture();
  expect(()=>new DnsChallengeJournal(db,{dnsJournalVersion:0} as never)).toThrow('compatibility');
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='acme_dns_challenges'").get()).toBeUndefined();
});

it('rejects an existing journal with unexpected columns',()=>{
  const {db}=fixture();
  db.exec('CREATE TABLE acme_dns_challenges (operation_id TEXT, unexpected_secret TEXT)');
  expect(()=>new DnsChallengeJournal(db,{dnsJournalVersion:1})).toThrow('Unsupported DNS challenge journal schema');
});

it('persists manual publication, exact DNS observation, validation and manual cleanup',async()=>{
  const {db}=fixture(),journal=new DnsChallengeJournal(db,{dnsJournalVersion:1}),input=challenge(),provider=new ManualDns01Provider();
  expect(journal.create(input,'manual').state).toBe('pending');
  expect(journal.create(input,'manual')).toEqual(journal.get(input.operationId));
  expect(()=>journal.create({...input,value:Buffer.alloc(32,8).toString('base64url')},'manual')).toThrow('conflicts');
  journal.beginPresentation(input.operationId);
  const presented=await provider.present(input);
  expect(journal.finishPresentation(input.operationId,presented).state).toBe('awaiting_manual');
  journal.manualPublished(input.operationId);
  const observed=await observeDns01(presented.record,async()=>[[input.value]]);
  expect(()=>journal.observe(input.operationId,{...observed,operationId:'b'.repeat(32)})).toThrow('not observed');
  expect(journal.observe(input.operationId,observed).state).toBe('ready');
  journal.beginValidation(input.operationId);
  expect(()=>journal.cancel(input.operationId)).toThrow('cannot be cancelled');
  journal.finishValidation(input.operationId,'valid');journal.beginCleanup(input.operationId);
  expect(journal.finishCleanup(input.operationId,await provider.remove(presented.record)).state).toBe('awaiting_manual_cleanup');
  expect(()=>journal.manualCleanupObserved(input.operationId,observed)).toThrow('not confirmed');
  const missing=await observeDns01(presented.record,async()=>[]);
  expect(journal.manualCleanupObserved(input.operationId,missing)).toMatchObject({state:'completed',outcome:'valid'});
});

it('retains a Cloudflare record ID and rejects cleanup or observation for another challenge',()=>{
  const {db}=fixture(),journal=new DnsChallengeJournal(db,{dnsJournalVersion:1}),input=challenge();
  const pending=journal.create(input,'cloudflare');journal.beginPresentation(input.operationId);
  const record={operationId:input.operationId,name:pending.name,value:pending.value,recordId:'b'.repeat(32)};
  expect(()=>journal.finishPresentation(input.operationId,{status:'awaiting_dns',record:{...record,value:'wrong'}})).toThrow('does not match');
  expect(journal.finishPresentation(input.operationId,{status:'awaiting_dns',record})).toMatchObject({state:'awaiting_dns',recordId:record.recordId});
  expect(()=>journal.observe(input.operationId,{...record,status:'pending'})).toThrow('not observed');
  journal.observe(input.operationId,{...record,status:'observed'});journal.beginValidation(input.operationId);
  journal.finishValidation(input.operationId,'invalid');journal.beginCleanup(input.operationId);
  expect(()=>journal.finishCleanup(input.operationId,{status:'manual_action_required'})).toThrow('does not match');
  expect(journal.finishCleanup(input.operationId,{status:'removed'})).toMatchObject({state:'completed',outcome:'invalid'});
  expect(JSON.stringify(journal.get(input.operationId))).not.toContain('fixture-only-token');
});

it('cancels only safe states and keeps published records in cleanup',async()=>{
  const {db}=fixture(),journal=new DnsChallengeJournal(db,{dnsJournalVersion:1}),input=challenge();
  journal.create(input,'manual');expect(journal.cancel(input.operationId)).toMatchObject({state:'cancelled',outcome:'cancelled'});
  const next={...input,operationId:'b'.repeat(32)};journal.create(next,'manual');journal.beginPresentation(next.operationId);
  const provider=new ManualDns01Provider();journal.finishPresentation(next.operationId,await provider.present(next));
  expect(journal.cancel(next.operationId)).toMatchObject({state:'ready_to_cleanup',outcome:'cancelled'});
});

it('leaves a killed in-flight publication fenced and never starts it a second time',async()=>{
  const {dir,db}=fixture();db.close();const input=challenge();
  const sqlitePath=createRequire(import.meta.url).resolve('better-sqlite3');
  const moduleUrl=new URL('../../src/agent/acme/dns-journal.ts',import.meta.url).href;
  const program=`const {default:Database}=await import(process.argv[1]);const {DnsChallengeJournal}=await import(process.argv[2]);const db=new Database(process.argv[3]);const j=new DnsChallengeJournal(db,{dnsJournalVersion:1});j.create(JSON.parse(process.argv[4]),'cloudflare');j.beginPresentation(JSON.parse(process.argv[4]).operationId);process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program,sqlitePath,moduleUrl,join(dir,'agent.sqlite'),JSON.stringify(input)],{stdio:['ignore','pipe','pipe']});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('fixture exited');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timed out')),5000);})]);
    expect(ready[0].toString()).toBe('ready\n');const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
  } finally {if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  const reopened=new Database(join(dir,'agent.sqlite'));cleanup.push(()=>reopened.close());const journal=new DnsChallengeJournal(reopened,{dnsJournalVersion:1});
  expect(journal.get(input.operationId)?.state).toBe('presenting');
  expect(()=>journal.beginPresentation(input.operationId)).toThrow('does not match');
  expect(journal.needsReview(input.operationId,'presenting')).toMatchObject({state:'needs_review',reviewFrom:'presenting'});
  expect(()=>journal.cancel(input.operationId)).toThrow('cannot be cancelled');
});

it('fails closed on inconsistent stored state',()=>{
  const {db}=fixture(),journal=new DnsChallengeJournal(db,{dnsJournalVersion:1}),input=challenge();journal.create(input,'cloudflare');
  db.prepare("UPDATE acme_dns_challenges SET state='completed',outcome='valid' WHERE operation_id=?").run(input.operationId);
  expect(()=>journal.get(input.operationId)).toThrow('Invalid DNS challenge journal');
});

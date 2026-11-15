import assert from 'node:assert/strict';
import { once } from 'node:events';
import { linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { RestoreJournal } from '/app/dist/agent/restore-journal.js';
import { cancelLegacyUploadOffline } from '/app/dist/agent/restore-legacy-offline.js';

const dataDir='/fixture',operationId='a'.repeat(32),serviceId=randomUUID();
const archiveDir=`${dataDir}/restore-archives`,pending=`${archiveDir}/.pending-${operationId}-${'b'.repeat(32)}`,published=`${archiveDir}/${operationId}.enc`;
mkdirSync(archiveDir,{mode:0o700});writeFileSync(pending,'encrypted fixture',{mode:0o600});linkSync(pending,published);
writeFileSync(`${dataDir}/source-database`,'source fixture',{mode:0o600});
let db=new Database(`${dataDir}/agent.sqlite`);db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');
let journal=new RestoreJournal(db,()=>false);journal.beginUpload({id:operationId,serviceId,kind:'postgres'});db.close();
const program=`import Database from '/app/node_modules/better-sqlite3/lib/index.js';import {RestoreJournal} from '/app/dist/agent/restore-journal.js';import {cancelLegacyUploadOffline} from '/app/dist/agent/restore-legacy-offline.js';import {writeSync} from 'node:fs';const db=new Database('/fixture/agent.sqlite');const journal=new RestoreJournal(db,()=>false);journal.advance=()=>{writeSync(1,'ready\\n');process.kill(process.pid,'SIGSTOP');};cancelLegacyUploadOffline({journal,dataDir:'/fixture',operationId:process.env.TEST_OPERATION,serviceId:process.env.TEST_SERVICE});`;
const child=spawn(process.execPath,['--input-type=module','-e',program],{env:{...process.env,TEST_OPERATION:operationId,TEST_SERVICE:serviceId},stdio:['ignore','pipe','pipe']});
let timer;
try {
  const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Cleanup process exited early');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cleanup process timed out')),5000);})]);
  assert.equal(ready[0].toString(),'ready\n');const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
} finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
db=new Database(`${dataDir}/agent.sqlite`);journal=new RestoreJournal(db,()=>false);
assert.equal(journal.get(operationId).phase,'uploading');assert.deepEqual(readdirSync(archiveDir),[]);
assert.equal(cancelLegacyUploadOffline({journal,dataDir,operationId,serviceId}).phase,'cancelled');
assert.equal(readFileSync(`${dataDir}/source-database`,'utf8'),'source fixture');db.close();
console.log('PASS offline legacy upload cleanup survives process death');

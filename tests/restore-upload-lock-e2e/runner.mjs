import { writeFileSync, readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { RestoreJournal } from '/app/dist/agent/restore-journal.js';
import { uploadRestoreArchive } from '/app/dist/agent/restore-upload.js';
import { stageRestoreArchive } from '/app/dist/agent/restore-archive.js';
import { acquireRestoreUploadLock } from '/app/dist/agent/restore-upload-lock.js';
import { createAgent } from '/app/dist/agent/app.js';

const dataDir='/fixture',operationId=process.env.TEST_OPERATION,serviceId=process.env.TEST_SERVICE;
if(!/^[a-f0-9]{32}$/.test(operationId)||!/^[a-f0-9-]{36}$/.test(serviceId))throw new Error('Invalid fixture identity');
if(['writer','legacy_writer','compat_writer','unregistered_writer'].includes(process.env.TEST_MODE)){
  const db=new Database(`${dataDir}/agent.sqlite`);db.exec('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');
  const journal=new RestoreJournal(db,()=>false),source=new PassThrough();let held;
  if(process.env.TEST_MODE==='unregistered_writer') {
    if(!/^[a-f0-9]{32}$/.test(process.env.TEST_LOCK_ID))throw new Error('Invalid fixture lock identity');
    held=acquireRestoreUploadLock(dataDir,operationId,true,process.env.TEST_LOCK_ID);
  } else if(['legacy_writer','compat_writer'].includes(process.env.TEST_MODE)) {
    journal.beginUpload({id:operationId,serviceId,kind:'postgres'});
    if(process.env.TEST_MODE==='compat_writer')held=acquireRestoreUploadLock(dataDir,operationId,true);
    void stageRestoreArchive({operationId,dataDir,key:Buffer.alloc(32),input:()=>source}).catch(()=>{});
  } else {
    void uploadRestoreArchive({journal,operationId,serviceId,kind:'postgres',dataDir,key:Buffer.alloc(32),input:()=>source}).catch(()=>{});
  }
  if(process.env.TEST_MODE!=='unregistered_writer')source.write('private fixture data');
  setTimeout(()=>writeFileSync(`${dataDir}/ready`,'ready',{mode:0o600}),500);
  setInterval(()=>{void held;},1000);
}else{
  const config={dataDir,token:'fixture-token',socketPath:`${dataDir}/agent.sock`,dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'};
  const app=await createAgent(config,{status:async()=>({online:true}),inspectService:async()=>({state:'unknown'}),apply:async()=>{throw new Error('Unexpected apply');}});
  try{
    const path=`/services/${serviceId}/database-restore/${operationId}`,headers={authorization:'Bearer fixture-token'};
    const response=await app.inject({method:'POST',url:`${path}/cancel`,headers});
    const expected=process.env.TEST_MODE==='dead'?200:409;
    if(response.statusCode!==expected)throw new Error(`Expected ${expected}, got ${response.statusCode}`);
    const status=await app.inject({url:path,headers});
    if(status.json().phase!==(expected===409?'uploading':'cancelled'))throw new Error('Unexpected journal state');
    if((process.env.TEST_MODE.startsWith('legacy_')||process.env.TEST_MODE.startsWith('compat_'))&&readdirSync(`${dataDir}/restore-archives`).length!==1)throw new Error('Legacy archive was changed without proof that its writer stopped');
    if(expected===200){
      if(readdirSync(`${dataDir}/restore-archives`).length!==0)throw new Error('Interrupted archive was retained');
      const nextId=randomBytes(16).toString('hex');
      const next=await app.inject({method:'POST',url:`/services/${serviceId}/database-restore/upload?operationId=${nextId}&kind=postgres`,headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('next archive')});
      if(next.statusCode!==200||next.json().phase!=='reserved')throw new Error('The service was not released for a new upload');
    }
  }finally{await app.close();}
}

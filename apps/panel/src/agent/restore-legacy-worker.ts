import Database from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { RestoreJournal } from './restore-journal.js';
import { cancelLegacyUploadOffline } from './restore-legacy-offline.js';

// This worker does not establish host quiescence. It is only safe to invoke
// after the supervisor has stopped and fenced all writers and data mounts.
function execute():void {
  const [operationId,serviceId,...extra]=process.argv.slice(2),uid=process.getuid?.(),dataDir='/data';
  if(extra.length||typeof uid!=='number'||uid<=0||!operationId||!/^[a-f0-9]{32}$/.test(operationId)||!serviceId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(serviceId))throw new Error('Invalid worker request');
  const directory=lstatSync(dataDir);
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==uid||(directory.mode&0o077)!==0)throw new Error('Invalid worker data directory');
  const path=join(dataDir,'agent.sqlite');
  for(const suffix of ['','-wal','-shm']){
    let info;
    try{info=lstatSync(path+suffix);}catch(error){if(suffix && (error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==uid||info.nlink!==1||(info.mode&0o777)!==0o600)throw new Error('Invalid worker database');
  }
  const db=new Database(path,{fileMustExist:true,timeout:0});
  try {
    db.pragma('busy_timeout = 0');db.pragma('synchronous = FULL');db.pragma('trusted_schema = OFF');
    const expected:Record<string,string[]>={
      operations:['id','request_hash','state','response','updated_at','previous_spec','previous_recorded','target_spec','operation_stage','previous_error','service_id'],
      restore_operations:['id','service_id','kind','archive_sha256','phase','updated_at'],
      restore_switch_intents:['id','service_id','service_version','sealed_plan','created_at','stage'],
      restore_retained_volumes:['operation_id','service_id','volume_name','reason','created_at'],
      restore_volume_bindings:['service_id','operation_id','volume_name','kind','created_at'],
    };
    if(db.pragma('quick_check',{simple:true})!=='ok'||db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get())throw new Error('Invalid worker journal');
    for(const [table,columns] of Object.entries(expected)){
      const info=db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;type:string;pk:number}[];
      if(info.length!==columns.length||info.some(column=>!columns.includes(column.name))||
        (table==='restore_operations' && info.some(column=>column.type!=='TEXT'||column.pk!==(column.name==='id'?1:0))))throw new Error('Unsupported worker journal schema');
    }
    for(const [table,marker] of [['restore_operations',"'discarding_candidate'"],['restore_switch_intents',"'rolling_back'"],['restore_retained_volumes',"'pre_restore_source'"]] as const){
      const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql?:unknown}|undefined;
      if(typeof row?.sql!=='string'||!row.sql.includes(marker))throw new Error('Unsupported worker journal schema');
    }
    const indexes=db.prepare('PRAGMA index_list(restore_operations)').all() as {name:string;unique:number;partial:number}[];
    const index=indexes.find(item=>item.name==='restore_one_active_per_service');
    const indexColumns=db.prepare('PRAGMA index_info(restore_one_active_per_service)').all() as {name:string}[];
    const indexSql=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='restore_one_active_per_service'").get() as {sql?:unknown}|undefined;
    if(index?.unique!==1||index.partial!==1||indexColumns.length!==1||indexColumns[0]?.name!=='service_id'||typeof indexSql?.sql!=='string'||!indexSql.sql.replace(/\s+/g,'').toLowerCase().endsWith("wherephasenotin('completed','cancelled')"))throw new Error('Unsupported worker journal schema');
    const journal=new RestoreJournal(db,()=>false);
    const result=db.transaction(()=>{
      if(db.prepare("SELECT 1 FROM operations WHERE state='running' LIMIT 1").get())throw new Error('Another operation requires recovery');
      return cancelLegacyUploadOffline({journal,dataDir,operationId,serviceId});
    }).immediate();
    process.stdout.write(JSON.stringify({operationId:result.id,phase:result.phase})+'\n');
  } finally {db.close();}
}

try {execute();} catch {process.stderr.write('Legacy upload cleanup could not be completed.\n');process.exitCode=1;}

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ServiceSpec } from 'dockerode';

// Reserved for the ingress itself, never for a user service operation.
export const HTTPS_MIGRATION_OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const ID = HTTPS_MIGRATION_OPERATION_ID;
const HASH = createHash('sha256').update('servus-ingress-migration-v1').digest('hex');
type Row = { request_hash:string; state:string; previous_spec:string|null; target_spec:string|null; previous_recorded:number; operation_stage:string };
export type IngressIntent = { previous:ServiceSpec; target:ServiceSpec; stage:'applying'|'rolling_back' };

/** Stores the intent before changing Docker. Unresolved intent also fences backups. */
export class HttpsMigrationJournal {
  constructor(private readonly db:Database.Database, private readonly seal:(value:string)=>string, private readonly open:(value:string)=>string) {}

  load():IngressIntent|undefined {
    const row=this.db.prepare('SELECT request_hash,state,previous_spec,target_spec,previous_recorded,operation_stage FROM operations WHERE id=?').get(ID) as Row|undefined;
    if(!row)return undefined;
    if(row.request_hash!==HASH)throw new Error('Ingress migration journal identity conflict.');
    if(row.state==='succeeded')return undefined;
    if(row.state!=='running'||row.previous_recorded!==1||!row.previous_spec?.startsWith('enc:v1:')||!row.target_spec?.startsWith('enc:v1:')||!['applying','rolling_back'].includes(row.operation_stage))throw new Error('Invalid ingress migration journal.');
    const parse=(value:string):ServiceSpec=>{
      const result:unknown=JSON.parse(this.open(value));
      if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid ingress migration snapshot.');
      return result as ServiceSpec;
    };
    return {previous:parse(row.previous_spec),target:parse(row.target_spec),stage:row.operation_stage as IngressIntent['stage']};
  }

  begin(previous:ServiceSpec,target:ServiceSpec):void {
    const before=this.seal(JSON.stringify(previous)),after=this.seal(JSON.stringify(target));
    if(!before.startsWith('enc:v1:')||!after.startsWith('enc:v1:'))throw new Error('Ingress snapshots must be encrypted.');
    this.db.transaction(()=>{
      const existing=this.db.prepare('SELECT request_hash,state FROM operations WHERE id=?').get(ID) as {request_hash:string;state:string}|undefined;
      if(existing && (existing.request_hash!==HASH||existing.state!=='succeeded'))throw new Error('Ingress migration already exists or requires recovery.');
      if(this.db.prepare("SELECT 1 FROM operations WHERE state='running' LIMIT 1").get())throw new Error('Another operation is running.');
      if(existing)this.db.prepare('DELETE FROM operations WHERE id=? AND request_hash=?').run(ID,HASH);
      this.db.prepare("INSERT INTO operations(id,request_hash,state,response,updated_at,previous_spec,previous_recorded,target_spec,operation_stage,service_id) VALUES(?,?,'running','{}',?,?,1,?,'applying',NULL)").run(ID,HASH,new Date().toISOString(),before,after);
    }).immediate();
  }

  rollback():void {
    const result=this.db.prepare("UPDATE operations SET operation_stage='rolling_back',updated_at=? WHERE id=? AND request_hash=? AND state='running' AND operation_stage='applying'").run(new Date().toISOString(),ID,HASH);
    if(result.changes!==1)throw new Error('Ingress migration is not ready for rollback.');
  }

  /** Call only after independently verifying the target or original ingress is healthy. */
  finish(outcome:'applied'|'restored'):void {
    this.db.transaction(()=>{
      const intent=this.load();
      if(!intent || (outcome==='applied' && intent.stage!=='applying') || (outcome==='restored' && intent.stage!=='rolling_back'))throw new Error('Ingress migration outcome does not match its stage.');
      if(outcome==='restored')this.db.prepare('DELETE FROM operations WHERE id=? AND request_hash=?').run(ID,HASH);
      else this.db.prepare("UPDATE operations SET state='succeeded',response=?,updated_at=? WHERE id=? AND request_hash=? AND state='running'").run(JSON.stringify({state:'running',kind:'https_ingress'}),new Date().toISOString(),ID,HASH);
    }).immediate();
  }
}

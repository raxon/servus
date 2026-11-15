import type Database from 'better-sqlite3';
import { challengeRecord, dns01IdPattern, type Dns01Challenge, type Dns01Record } from './dns01.js';
import type { CloudflareDns01Record } from './cloudflare.js';
import type { Dns01Observation } from './dns-observation.js';

type Provider = 'manual'|'cloudflare';
type State = 'pending'|'presenting'|'awaiting_manual'|'awaiting_dns'|'ready'|'validating'|'ready_to_cleanup'|'cleaning'|'awaiting_manual_cleanup'|'completed'|'cancelled'|'needs_review';
type Outcome = 'valid'|'invalid'|'cancelled';
type ReviewFrom = 'presenting'|'validating'|'cleaning';
export interface DnsJournalRecord extends Dns01Record {
  identifier:string;provider:Provider;state:State;recordId:string|null;outcome:Outcome|null;reviewFrom:ReviewFrom|null;updatedAt:string;
}

/**
 * DNS intent is kept in the agent journal. Construct only after the installed
 * host updater has explicitly confirmed support for this schema; older host
 * snapshots reject additional tables. No production caller is enabled yet.
 */
export class DnsChallengeJournal {
  constructor(private readonly db:Database.Database, compatibility:{dnsJournalVersion:1}) {
    if(!compatibility || compatibility.dnsJournalVersion!==1)throw new Error('DNS journal schema compatibility is not confirmed.');
    db.exec(`CREATE TABLE IF NOT EXISTS acme_dns_challenges (
      operation_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, record_name TEXT NOT NULL, value TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('manual','cloudflare')),
      state TEXT NOT NULL CHECK(state IN ('pending','presenting','awaiting_manual','awaiting_dns','ready','validating','ready_to_cleanup','cleaning','awaiting_manual_cleanup','completed','cancelled','needs_review')),
      record_id TEXT, outcome TEXT CHECK(outcome IN ('valid','invalid','cancelled')),
      review_from TEXT CHECK(review_from IN ('presenting','validating','cleaning')), updated_at TEXT NOT NULL
    )`);
    const expected=['operation_id','identifier','record_name','value','provider','state','record_id','outcome','review_from','updated_at'];
    const actual=db.prepare('PRAGMA table_info(acme_dns_challenges)').all() as {name:string;type:string;notnull:number;pk:number}[];
    if(actual.length!==expected.length||actual.some((column,index)=>column.name!==expected[index]||column.type!=='TEXT'||column.pk!==(index===0?1:0)||column.notnull!==([1,2,3,4,5,9].includes(index)?1:0)))throw new Error('Unsupported DNS challenge journal schema.');
  }

  get(id:string):DnsJournalRecord|undefined {
    if(typeof id!=='string'||!dns01IdPattern.test(id))throw new Error('Invalid DNS challenge identity.');
    const row=this.db.prepare('SELECT operation_id,identifier,record_name,value,provider,state,record_id,outcome,review_from,updated_at FROM acme_dns_challenges WHERE operation_id=?').get(id) as Record<string,unknown>|undefined;
    if(!row)return undefined;
    const result={operationId:row.operation_id,identifier:row.identifier,name:row.record_name,value:row.value,provider:row.provider,state:row.state,recordId:row.record_id,outcome:row.outcome,reviewFrom:row.review_from,updatedAt:row.updated_at} as DnsJournalRecord;
    const record=challengeRecord({operationId:result.operationId,identifier:result.identifier,value:result.value});
    const host=record.name.slice('_acme-challenge.'.length),identifier=result.identifier.startsWith('*.')?`*.${host}`:host;
    const states:State[]=['pending','presenting','awaiting_manual','awaiting_dns','ready','validating','ready_to_cleanup','cleaning','awaiting_manual_cleanup','completed','cancelled','needs_review'];
    const beforeOutcome=['pending','presenting','awaiting_manual','awaiting_dns','ready','validating'];
    const afterOutcome=['ready_to_cleanup','cleaning','awaiting_manual_cleanup','completed','cancelled'];
    const cloudflareWithRecord=['awaiting_dns','ready','validating','ready_to_cleanup','cleaning','completed'];
    if(record.name!==result.name || identifier!==result.identifier || !['manual','cloudflare'].includes(result.provider) || !states.includes(result.state) ||
      (result.recordId!==null && (typeof result.recordId!=='string'||!dns01IdPattern.test(result.recordId))) ||
      (result.provider==='manual' && result.recordId!==null) ||
      (['pending','presenting','cancelled'].includes(result.state) && result.recordId!==null) ||
      (result.provider==='cloudflare' && cloudflareWithRecord.includes(result.state) && result.recordId===null) ||
      (result.provider==='cloudflare' && result.state==='needs_review' && (result.reviewFrom==='presenting')!==(result.recordId===null)) ||
      (result.provider==='cloudflare' && ['awaiting_manual','awaiting_manual_cleanup'].includes(result.state)) ||
      (result.outcome!==null && !['valid','invalid','cancelled'].includes(result.outcome)) ||
      (beforeOutcome.includes(result.state) && result.outcome!==null) ||
      (afterOutcome.includes(result.state) && result.outcome===null) ||
      (result.state==='cancelled' && result.outcome!=='cancelled') ||
      (result.reviewFrom!==null && !['presenting','validating','cleaning'].includes(result.reviewFrom)) ||
      ((result.state==='needs_review')!==(result.reviewFrom!==null)) ||
      (result.state==='needs_review' && ((result.reviewFrom==='cleaning')!==(result.outcome!==null))) ||
      (typeof result.updatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.updatedAt)))throw new Error('Invalid DNS challenge journal.');
    return result;
  }

  create(challenge:Dns01Challenge,provider:Provider):DnsJournalRecord {
    const record=challengeRecord(challenge);
    if(provider!=='manual'&&provider!=='cloudflare')throw new Error('Invalid DNS provider.');
    const host=record.name.slice('_acme-challenge.'.length),identifier=challenge.identifier.startsWith('*.')?`*.${host}`:host;
    return this.db.transaction(()=>{
      const old=this.get(record.operationId);
      if(old){if(old.identifier!==identifier||old.name!==record.name||old.value!==record.value||old.provider!==provider)throw new Error('DNS challenge identity conflicts.');return old;}
      this.db.prepare("INSERT INTO acme_dns_challenges VALUES(?,?,?,?,?,'pending',NULL,NULL,NULL,?)").run(record.operationId,identifier,record.name,record.value,provider,new Date().toISOString());
      return this.get(record.operationId)!;
    }).immediate();
  }

  private move(id:string,from:State,to:State,values:{recordId?:string|null;outcome?:Outcome|null;reviewFrom?:ReviewFrom|null}={}):DnsJournalRecord {
    return this.db.transaction(()=>{
      const current=this.get(id);if(!current||current.state!==from)throw new Error('DNS challenge state does not match.');
      this.db.prepare('UPDATE acme_dns_challenges SET state=?,record_id=?,outcome=?,review_from=?,updated_at=? WHERE operation_id=? AND state=?')
        .run(to,values.recordId===undefined?current.recordId:values.recordId,values.outcome===undefined?current.outcome:values.outcome,values.reviewFrom===undefined?current.reviewFrom:values.reviewFrom,new Date().toISOString(),id,from);
      return this.get(id)!;
    }).immediate();
  }
  beginPresentation(id:string):DnsJournalRecord{return this.move(id,'pending','presenting');}
  finishPresentation(id:string,result:{status:'manual_action_required'|'awaiting_dns';record:Dns01Record|CloudflareDns01Record}):DnsJournalRecord {
    const current=this.get(id),record=result?.record;
    if(!current||current.state!=='presenting'||!record||record.operationId!==id||record.name!==current.name||record.value!==current.value)throw new Error('DNS presentation does not match the intent.');
    if(current.provider==='manual'&&result.status==='manual_action_required'&&!('recordId' in record))return this.move(id,'presenting','awaiting_manual');
    if(current.provider==='cloudflare'&&result.status==='awaiting_dns'&&'recordId' in record&&typeof record.recordId==='string'&&dns01IdPattern.test(record.recordId))return this.move(id,'presenting','awaiting_dns',{recordId:record.recordId});
    throw new Error('DNS presentation does not match the provider.');
  }
  manualPublished(id:string):DnsJournalRecord {
    const row=this.get(id);if(row?.provider!=='manual')throw new Error('DNS challenge is not manual.');
    return this.move(id,'awaiting_manual','awaiting_dns');
  }
  observe(id:string,result:Dns01Observation):DnsJournalRecord {
    const row=this.get(id);
    if(result?.status!=='observed'||result.operationId!==id||result.name!==row?.name||result.value!==row.value)throw new Error('DNS value is not observed.');
    return this.move(id,'awaiting_dns','ready');
  }
  beginValidation(id:string):DnsJournalRecord{return this.move(id,'ready','validating');}
  finishValidation(id:string,outcome:'valid'|'invalid'):DnsJournalRecord {
    if(outcome!=='valid'&&outcome!=='invalid')throw new Error('Invalid DNS validation outcome.');
    return this.move(id,'validating','ready_to_cleanup',{outcome});
  }
  cancel(id:string):DnsJournalRecord {
    const row=this.get(id);if(!row)throw new Error('DNS challenge not found.');
    if(row.state==='pending')return this.move(id,'pending','cancelled',{outcome:'cancelled'});
    if(row.state==='awaiting_manual'||row.state==='awaiting_dns'||row.state==='ready')return this.move(id,row.state,'ready_to_cleanup',{outcome:'cancelled'});
    throw new Error('DNS challenge cannot be cancelled in this state.');
  }
  beginCleanup(id:string):DnsJournalRecord{return this.move(id,'ready_to_cleanup','cleaning');}
  finishCleanup(id:string,result:{status:'removed'|'manual_action_required'}):DnsJournalRecord {
    const row=this.get(id);
    if(row?.state!=='cleaning'||!row.outcome)throw new Error('DNS cleanup is not ready.');
    if(row.provider==='cloudflare'&&result?.status==='removed'&&row.recordId)return this.move(id,'cleaning','completed');
    if(row.provider==='manual'&&result?.status==='manual_action_required')return this.move(id,'cleaning','awaiting_manual_cleanup');
    throw new Error('DNS cleanup does not match the provider.');
  }
  manualCleanupObserved(id:string,result:Dns01Observation):DnsJournalRecord {
    const row=this.get(id);if(row?.provider!=='manual'||result?.status!=='pending'||result.operationId!==id||result.name!==row.name||result.value!==row.value)throw new Error('Manual DNS cleanup is not confirmed.');
    return this.move(id,'awaiting_manual_cleanup','completed');
  }
  needsReview(id:string,phase:ReviewFrom):DnsJournalRecord {
    if(!['presenting','validating','cleaning'].includes(phase))throw new Error('Invalid DNS review phase.');
    return this.move(id,phase,'needs_review',{reviewFrom:phase});
  }
}

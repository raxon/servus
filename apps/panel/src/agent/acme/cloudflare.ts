import { canonicalDnsName, challengeRecord, dns01IdPattern, Dns01ProviderError, validateDns01Record, type Dns01Challenge, type Dns01Provider, type Dns01Record } from './dns01.js';

const api = 'https://api.cloudflare.com/client/v4';
const tokenPattern = /^[A-Za-z0-9_-]{1,256}$/;
const maxResponse = 128 * 1024;
const timeoutMs = 15_000;
type Fetch = typeof fetch;
export interface CloudflareDns01Record extends Dns01Record { recordId: string }

function desired(challenge: Dns01Challenge, zone: string): Dns01Record {
  const record = challengeRecord(challenge), host = record.name.slice('_acme-challenge.'.length);
  if (host !== zone && !host.endsWith('.' + zone)) throw new Dns01ProviderError('invalid_input');
  return record;
}

function owner(operationId: string): string { return `servus-acme-${operationId}`; }

function isRecord(value: unknown, expected: CloudflareDns01Record): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['id','type','name','content','comment'].every(key=>Object.hasOwn(record,key)) && record.id === expected.recordId && record.type === 'TXT' && record.name === expected.name && (record.content === expected.value || record.content === `"${expected.value}"`) && record.comment === owner(expected.operationId);
}

/** Callers supply a zone-scoped API token and must never log it. The token's permissions are not inferred from its format. */
export class CloudflareDns01Provider implements Dns01Provider<CloudflareDns01Record> {
  private readonly zone: string;
  readonly #token: string;
  constructor(private readonly zoneId: string, zoneName: string, token: string, private readonly transport: Fetch = fetch) {
    if (typeof zoneId !== 'string' || !dns01IdPattern.test(zoneId) || typeof token !== 'string' || !tokenPattern.test(token) || token.startsWith('cfk_') || typeof transport !== 'function') throw new Dns01ProviderError('invalid_input');
    this.zone = canonicalDnsName(zoneName);
    this.#token = token;
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{result:unknown;resultInfo:unknown}> {
    let response: Response;
    try {
      response = await this.transport(`${api}/zones/${this.zoneId}/dns_records${path}`, {
        method, headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new Dns01ProviderError('uncertain'); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Ignore response body cleanup failures. */ }
      throw new Dns01ProviderError(response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'rejected' : 'uncertain');
    }
    try {
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > maxResponse)) throw new Error();
      if (!response.body) throw new Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > maxResponse) throw new Error(); chunks.push(part.value);
        }
      } catch (error) { try { await reader.cancel(); } catch { /* Preserve the original failure. */ } throw error; }
      finally { reader.releaseLock(); }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed,'success') || (parsed as {success?:unknown}).success !== true || !Object.hasOwn(parsed,'result')) throw new Error();
      const envelope=parsed as {result:unknown;result_info?:unknown};
      return {result:envelope.result,resultInfo:envelope.result_info};
    } catch { throw new Dns01ProviderError('uncertain'); }
  }

  async present(challenge: Dns01Challenge): Promise<{status:'awaiting_dns';record:CloudflareDns01Record}> {
    const intent = desired(challenge, this.zone);
    // Persist the intent before calling this method. An uncertain result must
    // not be blindly retried: Cloudflare may have created the record already.
    const {result} = await this.request('POST', '', { type: 'TXT', name: intent.name, content: `"${intent.value}"`, ttl: 120, comment: owner(intent.operationId) });
    const recordId = result && typeof result === 'object' && !Array.isArray(result) ? (result as {id?:unknown}).id : undefined;
    if (typeof recordId !== 'string' || !dns01IdPattern.test(recordId)) throw new Dns01ProviderError('uncertain');
    const record = { ...intent, recordId };
    if (!isRecord(result, record)) throw new Dns01ProviderError('uncertain');
    return {status:'awaiting_dns',record};
  }

  async remove(record: CloudflareDns01Record): Promise<{status:'removed'}> {
    validateDns01Record(record);
    if (typeof record.recordId !== 'string' || !dns01IdPattern.test(record.recordId)) throw new Dns01ProviderError('invalid_input');
    const host = record.name.slice('_acme-challenge.'.length);
    if (host !== this.zone && !host.endsWith('.' + this.zone)) throw new Dns01ProviderError('invalid_input');
    const {result:found} = await this.request('GET', `/${record.recordId}`);
    if (!isRecord(found, record)) throw new Dns01ProviderError('ownership_mismatch');
    // Cloudflare does not document conditional DELETE for DNS records. A caller
    // must serialize its own changes and keep this record under its control.
    const {result:deleted} = await this.request('DELETE', `/${record.recordId}`);
    if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted) || !Object.hasOwn(deleted,'id') || (deleted as {id?:unknown}).id !== record.recordId) throw new Dns01ProviderError('uncertain');
    return {status:'removed'};
  }

  /** A missing record is not proof that an earlier timed-out POST has stopped.
   * A found record is an observation, not a snapshot isolated from other DNS writers.
   */
  async findPresented(challenge: Dns01Challenge): Promise<{status:'found';record:CloudflareDns01Record}|{status:'not_observed'}> {
    const intent=desired(challenge,this.zone), matches:CloudflareDns01Record[]=[];
    const seen=new Set<string>();let totalPages:number|undefined;
    for(let page=1;page<=10;page++) {
      const {result,resultInfo}=await this.request('GET',`?type=TXT&per_page=100&page=${page}`);
      if (!Array.isArray(result) || result.length>100 || !resultInfo || typeof resultInfo!=='object' || Array.isArray(resultInfo)) throw new Dns01ProviderError('uncertain');
      const info=resultInfo as {page?:unknown;total_pages?:unknown};
      if(info.page!==page || typeof info.total_pages!=='number' || !Number.isSafeInteger(info.total_pages) || info.total_pages<0 || info.total_pages>10 || (info.total_pages===0 && result.length!==0) || (totalPages!==undefined && totalPages!==info.total_pages)) throw new Dns01ProviderError('uncertain');
      totalPages=info.total_pages;
      for(const entry of result) {
        const id=entry && typeof entry==='object' && !Array.isArray(entry) ? (entry as {id?:unknown}).id : undefined;
        if(typeof id!=='string' || !dns01IdPattern.test(id) || seen.has(id))throw new Dns01ProviderError('uncertain');
        seen.add(id);
        const record={...intent,recordId:id};
        if(isRecord(entry,record))matches.push(record);
      }
      if(matches.length>1)throw new Dns01ProviderError('ownership_mismatch');
      if(page>=totalPages)break;
    }
    return matches.length ? {status:'found',record:matches[0]!} : {status:'not_observed'};
  }
}

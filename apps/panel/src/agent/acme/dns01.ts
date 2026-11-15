import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export interface Dns01Challenge {
  operationId: string;
  identifier: string;
  value: string;
}

export interface Dns01Record {
  operationId: string;
  name: string;
  value: string;
}

/** Provider errors never contain a credential or an external response body. */
export class Dns01ProviderError extends Error {
  constructor(readonly code: 'invalid_input' | 'rejected' | 'uncertain' | 'ownership_mismatch') {
    super(`DNS validation provider failed (${code}).`);
    this.name = 'Dns01ProviderError';
  }
}

/** Durable callers must serialize mutations and persist returned provider handles. */
export interface Dns01Provider<Record extends Dns01Record> {
  present(challenge: Dns01Challenge): Promise<{ status: 'awaiting_dns' | 'manual_action_required'; record: Record }>;
  remove(record: Record): Promise<{ status: 'removed' | 'manual_action_required' }>;
}

export const dns01IdPattern = /^[a-f0-9]{32}$/;
const valuePattern = /^[A-Za-z0-9_-]{43}$/;
export function validDns01Value(value: unknown): value is string {
  return typeof value === 'string' && valuePattern.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function canonicalDnsName(input: string): string {
  if (typeof input !== 'string' || !input || input.endsWith('.') || input.includes('*') || /[\s\x00-\x1f\x7f/\\?#@:%\[\]]/.test(input)) throw new Dns01ProviderError('invalid_input');
  const ascii = domainToASCII(input).toLowerCase();
  if (!ascii || isIP(ascii) || ascii.length > 253 || !ascii.includes('.') || ascii.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Dns01ProviderError('invalid_input');
  }
  return ascii;
}

export function challengeRecord(challenge: Dns01Challenge): Dns01Record {
  if (!challenge || typeof challenge.operationId !== 'string' || !dns01IdPattern.test(challenge.operationId) || !validDns01Value(challenge.value) || typeof challenge.identifier !== 'string') throw new Dns01ProviderError('invalid_input');
  const host = canonicalDnsName(challenge.identifier.startsWith('*.') ? challenge.identifier.slice(2) : challenge.identifier);
  const name = `_acme-challenge.${host}`;
  if (name.length > 253) throw new Dns01ProviderError('invalid_input');
  return { operationId: challenge.operationId, name, value: challenge.value };
}

export function validateDns01Record(record: Dns01Record): void {
  if (!record || typeof record.operationId !== 'string' || !dns01IdPattern.test(record.operationId) || !validDns01Value(record.value) || typeof record.name !== 'string' || !record.name.startsWith('_acme-challenge.')) throw new Dns01ProviderError('invalid_input');
  const host = canonicalDnsName(record.name.slice('_acme-challenge.'.length));
  if (record.name.length > 253 || record.name !== `_acme-challenge.${host}`) throw new Dns01ProviderError('invalid_input');
}

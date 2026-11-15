import { Resolver } from 'node:dns/promises';
import { validateDns01Record, type Dns01Record } from './dns01.js';

type TxtLookup = (name: string) => Promise<string[][]>;
export type Dns01Observation = { status: 'observed' | 'pending' | 'unavailable' };

/** One resolver observation is not proof of global propagation or CA validation. */
export async function observeDns01(record: Dns01Record, lookup?: TxtLookup): Promise<Dns01Observation> {
  validateDns01Record(record);
  const resolver = lookup ? undefined : new Resolver({timeout:3000,tries:2});
  const query = lookup ?? ((name: string) => resolver!.resolveTxt(name));
  try {
    const values: unknown = await query(record.name);
    if (!Array.isArray(values) || values.length > 100 || values.some(value => !Array.isArray(value) || value.length > 100 || value.some(part => typeof part !== 'string' || part.length > 255))) return {status:'unavailable'};
    return {status: values.some(parts => parts.join('') === record.value) ? 'observed' : 'pending'};
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as {code:unknown}).code : undefined;
    return {status: code === 'ENOTFOUND' || code === 'ENODATA' ? 'pending' : 'unavailable'};
  }
}

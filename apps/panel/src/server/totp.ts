import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_MS = 30_000;


export function encodeBase32(bytes: Uint8Array): string {
  let value = 0, bits = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeSecret(secret: string): Buffer {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Invalid authenticator secret');
  let value = 0, bits = 0;
  const output: number[] = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; output.push((value >>> bits) & 255); }
  }
  return Buffer.from(output);
}

/** RFC 4226 dynamic truncation, shared by the RFC 6238 time-based verifier. */
export function hotpCode(secret: string, counter: number, digits: 6 | 8 = 6): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid authenticator counter');
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeSecret(secret)).update(input).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).toString().padStart(digits, '0');
}

export function totpCode(secret: string, nowMs: number, digits: 6 | 8 = 6): string {
  return hotpCode(secret, Math.floor(nowMs / TOTP_PERIOD_MS), digits);
}

export function matchTotpCounter(secret: string, code: string, nowMs: number, lastCounter = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / TOTP_PERIOD_MS);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || counter <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(code), Buffer.from(hotpCode(secret, counter)))) return counter;
  }
  return null;
}

export function newTotpSecret(): string { return encodeBase32(randomBytes(20)); }
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(10).toString('hex').match(/.{5}/g)!.join('-'));
}
export function recoveryCodeHash(code: string): string | null {
  const normalized = code.trim().toLowerCase().replaceAll('-', '');
  if (!/^[a-f0-9]{20}$/.test(normalized)) return null;
  return createHash('sha256').update(`servus-2fa-recovery-v1\0${normalized}`).digest('hex');
}

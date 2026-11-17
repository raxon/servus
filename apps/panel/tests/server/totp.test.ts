import { describe, expect, it } from 'vitest';
import { encodeBase32, hotpCode, matchTotpCounter, newRecoveryCodes, newTotpSecret, recoveryCodeHash, totpCode } from '../../src/server/totp.js';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Public RFC 4226 test vector. gitleaks:allow

describe('RFC 4226 and RFC 6238 authenticator codes', () => {
  it('matches all RFC 4226 SHA-1 six-digit test vectors', () => {
    expect(encodeBase32(Buffer.from('12345678901234567890'))).toBe(secret);
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    for (const [counter, code] of expected.entries()) expect(hotpCode(secret, counter)).toBe(code);
  });
  it.each([
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ])('matches RFC 6238 SHA-1 at epoch second %s', (seconds, code) => {
    expect(totpCode(secret, (seconds as number) * 1000, 8)).toBe(code);
  });
  it('accepts only a one-step clock window and rejects used counters', () => {
    const now = 1_800_000;
    expect(matchTotpCounter(secret, hotpCode(secret, 60), now)).toBe(60);
    expect(matchTotpCounter(secret, hotpCode(secret, 59), now)).toBe(59);
    expect(matchTotpCounter(secret, hotpCode(secret, 61), now)).toBe(61);
    expect(matchTotpCounter(secret, hotpCode(secret, 58), now)).toBeNull();
    expect(matchTotpCounter(secret, hotpCode(secret, 62), now)).toBeNull();
    expect(matchTotpCounter(secret, hotpCode(secret, 60), now, 60)).toBeNull();
    expect(matchTotpCounter(secret, hotpCode(secret, 59), now, 60)).toBeNull();
    for (const code of ['75522', '0755224', '12345a', '123 456']) expect(matchTotpCounter(secret, code, now)).toBeNull();
  });
  it('generates independent authenticator secrets and normalized recovery hashes', () => {
    const a = newTotpSecret(), b = newTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/); expect(a).not.toBe(b);
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10); expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-f0-9]{5}(?:-[a-f0-9]{5}){3}$/);
      expect(recoveryCodeHash(code)).toMatch(/^[a-f0-9]{64}$/);
      expect(recoveryCodeHash(code.toUpperCase().replaceAll('-', ''))).toBe(recoveryCodeHash(code));
    }
    expect(recoveryCodeHash('not-a-recovery-code')).toBeNull();
  });
});

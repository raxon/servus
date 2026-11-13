import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretVault } from '../../src/shared/secrets.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
describe('local encrypted secret storage', () => {
  it('persists authenticated ciphertext, retains old revisions and restricts filesystem access', () => {
    const root = mkdtempSync(join(tmpdir(), 'panel-vault-')); roots.push(root);
    const vault = new SecretVault(root);
    const reference = vault.put('sensitive-value-123');
    expect(readFileSync(join(root, 'secrets', reference), 'utf8')).not.toContain('sensitive-value-123');
    const restored = new SecretVault(root);
    expect(restored.get(reference)).toBe('sensitive-value-123');
    const next = restored.put('replacement-secret');
    expect(next).not.toBe(reference);
    expect(restored.get(reference)).toBe('sensitive-value-123');
    expect(statSync(join(root, 'secret-key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'secrets', reference)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, 'secrets'))).toHaveLength(2);
  });
  it('rejects tampering, other installation keys and path traversal; redacts raw and URL-encoded values', () => {
    const root = mkdtempSync(join(tmpdir(), 'panel-vault-')); roots.push(root);
    const other = mkdtempSync(join(tmpdir(), 'panel-vault-')); roots.push(other);
    const vault = new SecretVault(root);
    vault.put('a-secret:/value');
    const encrypted = vault.seal('{"snapshot":"private"}');
    expect(vault.open(encrypted)).toBe('{"snapshot":"private"}');
    expect(() => new SecretVault(other).open(encrypted)).toThrow();
    expect(() => vault.open(encrypted.slice(0, -4) + 'AAAA')).toThrow();
    expect(() => vault.get('../secret-key')).toThrow();
    expect(vault.redact('a-secret:/value a-secret%3A%2Fvalue')).toBe('[REDACTED] [REDACTED]');
  });
});

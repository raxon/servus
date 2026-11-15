import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readRestoreArchive, stageRestoreArchive } from '../../src/agent/restore-archive.js';
import { SecretVault } from '../../src/shared/secrets.js';

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dataDir = mkdtempSync(join(tmpdir(), 'restore-archive-test-')); cleanup.push(dataDir); return { dataDir, operationId: 'a'.repeat(32), key: randomBytes(32) }; }
async function read(stream: Readable) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

it('derives stable, operation-specific archive keys without exposing the installation key', () => {
  const { dataDir, operationId } = fixture(), vault = new SecretVault(dataDir), key = vault.restoreArchiveKey(operationId);
  expect(key).toHaveLength(32); expect(new SecretVault(dataDir).restoreArchiveKey(operationId)).toEqual(key);
  expect(vault.restoreArchiveKey('b'.repeat(32))).not.toEqual(key);
  expect(key.toString('hex')).not.toBe(readFileSync(join(dataDir, 'secret-key'), 'utf8'));
  expect(() => vault.restoreArchiveKey('invalid')).toThrow('identity');
});

it('persists private ciphertext and authenticates an exact round trip', async () => {
  const base = fixture(), secret = Buffer.from('synthetic-private-database-content');
  const result = await stageRestoreArchive({ ...base, input: () => Readable.from([secret]) });
  expect(result).toEqual({ size: secret.length, sha256: createHash('sha256').update(secret).digest('hex') });
  const file = join(base.dataDir, 'restore-archives', `${base.operationId}.enc`), disk = readFileSync(file);
  expect(disk.includes(secret)).toBe(false); expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await read(readRestoreArchive(base))).toEqual(secret);
});

it('never replaces an existing archive with a reused operation identity', async () => {
  const base = fixture(); await stageRestoreArchive({ ...base, input: () => Readable.from(['first']) });
  await expect(stageRestoreArchive({ ...base, input: () => Readable.from(['second']) })).rejects.toThrow();
  expect((await read(readRestoreArchive(base))).toString()).toBe('first');
  expect(readdirSync(join(base.dataDir, 'restore-archives'))).toEqual([`${base.operationId}.enc`]);
});

it('publishes only one archive when two uploads use the same operation identity', async () => {
  const base = fixture();
  const outcomes = await Promise.allSettled(['first', 'second'].map(value => stageRestoreArchive({ ...base, input: () => Readable.from([value]) })));
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  const content = (await read(readRestoreArchive(base))).toString(); expect(['first', 'second']).toContain(content);
  const success = outcomes.find(result => result.status === 'fulfilled');
  expect(success?.status === 'fulfilled' && success.value.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  expect(readdirSync(join(base.dataDir, 'restore-archives'))).toEqual([`${base.operationId}.enc`]);
});

it('rejects modified ciphertext and incorrect keys', async () => {
  const base = fixture(); await stageRestoreArchive({ ...base, input: () => Readable.from(['synthetic secret']) });
  await expect(read(readRestoreArchive({ ...base, key: randomBytes(32) }))).rejects.toThrow();
  const file = join(base.dataDir, 'restore-archives', `${base.operationId}.enc`), data = readFileSync(file);
  data[21] ^= 1; writeFileSync(file, data);
  await expect(read(readRestoreArchive(base))).rejects.toThrow();
});

it('binds encrypted bytes to the operation identity', async () => {
  const base = fixture(); await stageRestoreArchive({ ...base, input: () => Readable.from(['synthetic secret']) });
  const other = 'b'.repeat(32), dir = join(base.dataDir, 'restore-archives');
  copyFileSync(join(dir, `${base.operationId}.enc`), join(dir, `${other}.enc`));
  await expect(read(readRestoreArchive({ ...base, operationId: other }))).rejects.toThrow();
});

it('cleans up incomplete and oversized uploads', async () => {
  const base = fixture();
  await expect(stageRestoreArchive({ ...base, sizeLimit: 3, input: () => Readable.from(['longer']) })).rejects.toThrow('exceeds');
  await expect(stageRestoreArchive({ ...base, input: () => Readable.from([]) })).rejects.toThrow('empty');
  expect(readdirSync(join(base.dataDir, 'restore-archives'))).toEqual([]);
});

it('removes an unfinished archive when upload is aborted', async () => {
  const base = fixture(), source = new PassThrough(), controller = new AbortController();
  const upload = stageRestoreArchive({ ...base, input: () => source, signal: controller.signal });
  source.write('partial archive');
  controller.abort();
  await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
  expect(readdirSync(join(base.dataDir, 'restore-archives'))).toEqual([]);
});

it('never publishes an incomplete upload when the writing process is killed', async () => {
  const base = fixture(), moduleUrl = new URL('../../src/agent/restore-archive.ts', import.meta.url).href;
  const program = `const {PassThrough}=await import('node:stream');const {stageRestoreArchive}=await import(process.argv[1]);const source=new PassThrough();void stageRestoreArchive({dataDir:process.argv[2],operationId:process.argv[3],key:Buffer.from(process.argv[4],'hex'),input:()=>source}).catch(()=>{});source.write('synthetic-private-partial-data');process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, moduleUrl, base.dataDir, base.operationId, base.key.toString('hex')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Archive fixture exited early.'); }), new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Archive fixture did not start.')),5000);})]);
    expect((await started)[0].toString()).toBe('ready\n');
    const dir = join(base.dataDir, 'restore-archives');
    await vi.waitFor(() => { const names = readdirSync(dir); expect(names).toHaveLength(1); expect(statSync(join(dir, names[0]!)).size).toBeGreaterThan(20); });
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const names = readdirSync(dir); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^\.pending-/);
    expect(readFileSync(join(dir, names[0]!)).includes(Buffer.from('synthetic-private-partial-data'))).toBe(false);
    expect(() => readRestoreArchive(base)).toThrow();
  } finally { if(timeout)clearTimeout(timeout);if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}, 10000);

it('rejects non-private directories, symlinks and hard-linked archives', async () => {
  const base = fixture(); chmodSync(base.dataDir, 0o755);
  await expect(stageRestoreArchive({ ...base, input: () => Readable.from(['x']) })).rejects.toThrow('not private');
  chmodSync(base.dataDir, 0o700);
  symlinkSync(tmpdir(), join(base.dataDir, 'restore-archives'));
  await expect(stageRestoreArchive({ ...base, input: () => Readable.from(['x']) })).rejects.toThrow('not private');
  rmSync(join(base.dataDir, 'restore-archives'));
  await stageRestoreArchive({ ...base, input: () => Readable.from(['archive']) });
  const path = join(base.dataDir, 'restore-archives', `${base.operationId}.enc`); linkSync(path, `${path}.link`);
  expect(() => readRestoreArchive(base)).toThrow('invalid');
});

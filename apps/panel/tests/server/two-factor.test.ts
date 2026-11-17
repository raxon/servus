import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { LocalTwoFactor } from '../../src/server/two-factor.js';
import { totpCode } from '../../src/server/totp.js';
import { createApp } from '../../src/server/app.js';
import * as passwords from '../../src/server/auth.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

function managerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servus-mfa-')), store = new Store(dir);
  let time = 1_800_000;
  const manager = new LocalTwoFactor(store, { now: () => time });
  const user = store.createUser('local@example.test', 'fixture-only', 'admin'), session = store.createSession(user.id);
  cleanup.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, manager, user, session, now: () => time, advance: (ms = 30_000) => { time += ms; } };
}

async function apiFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servus-mfa-api-')), store = new Store(dir);
  const app = await createApp({ dataDir: dir, store });
  cleanup.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.test', password: 'current-local-password' } });
  const token = setup.cookies.find(cookie => cookie.name === 'panel_session')!.value;
  const headers = { cookie: `panel_session=${token}`, 'x-csrf-token': setup.json().csrfToken };
  const password = 'current-local-password', user = setup.json().user;
  const post = (operation: string, body: unknown, requestHeaders = headers) => app.inject({ method: 'POST', url: `/api/v1/auth/two-factor/${operation}`, headers: requestHeaders, payload: body });
  return { app, store, user, token, headers, password, post };
}

describe('local authenticator persistence and replay protection', () => {
  it('encrypts enrollment and active secrets, stores only recovery hashes, and revokes other credentials', () => {
    const f = managerFixture(), enrollment = f.manager.setup(f.user);
    const pending = f.store.db.prepare('SELECT * FROM two_factor_auth').get() as { pending_secret: string };
    expect(pending.pending_secret).toMatch(/^enc:v1:/); expect(pending.pending_secret).not.toContain(enrollment.secret);
    expect(new URL(enrollment.uri).searchParams.get('secret')).toBe(enrollment.secret);
    const other = f.store.createSession(f.user.id), central = f.store.createSession(f.user.id, true);
    const project = f.store.createProject('mfa');
    f.store.db.prepare('INSERT INTO api_tokens(id,user_id,project_id,name,token_hash,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('token', f.user.id, project.id, 'fixture', 'a'.repeat(64), 'read', new Date().toISOString(), '2099-01-01T00:00:00.000Z');
    const enabled = f.manager.enable(f.user.id, f.session.token, totpCode(enrollment.secret, f.now()));
    const row = f.store.db.prepare('SELECT * FROM two_factor_auth').get() as { secret: string; pending_secret: null; recovery_hashes: string };
    expect(row.secret).toMatch(/^enc:v1:/); expect(row.pending_secret).toBeNull();
    expect(JSON.stringify(row)).not.toContain(enrollment.secret);
    for (const code of enabled.recoveryCodes) expect(row.recovery_hashes).not.toContain(code);
    expect(JSON.parse(row.recovery_hashes)).toHaveLength(10);
    expect(f.store.getSession(f.session.token)).toBeTruthy();
    expect(f.store.getSession(other.token)).toBeNull(); expect(f.store.getSession(central.token)).toBeNull();
    expect((f.store.db.prepare('SELECT revoked_at FROM api_tokens').get() as { revoked_at: string }).revoked_at).toBeTruthy();
    expect(f.manager.status(f.user.id)).toEqual({ enabled: true, pending: false, recoveryCodesRemaining: 10 });
  });
  it('requires an unused TOTP or recovery code and persists replay protection across instances', async () => {
    const f = managerFixture(), enrollment = f.manager.setup(f.user);
    const enabled = f.manager.enable(f.user.id, f.session.token, totpCode(enrollment.secret, f.now()));
    expect(f.manager.verifyLogin(f.user.id)).toBe(false);
    expect(f.manager.verifyLogin(f.user.id, totpCode(enrollment.secret, f.now()))).toBe(false);
    f.advance();
    const other = new Store(f.dir), manager = new LocalTwoFactor(other, { now: f.now });
    cleanup.push(async () => other.close());
    const code = totpCode(enrollment.secret, f.now());
    const results = await Promise.all([f.manager, manager].map(value => Promise.resolve().then(() => value.verifyLogin(f.user.id, code))));
    expect(results).toEqual([true, false]);
    expect(manager.verifyLogin(f.user.id, enabled.recoveryCodes[0]!.toUpperCase())).toBe(true);
    expect(f.manager.verifyLogin(f.user.id, enabled.recoveryCodes[0])).toBe(false);
    expect(f.manager.status(f.user.id).recoveryCodesRemaining).toBe(9);
  });
  it('expires pending setup and cannot replace an active authenticator without disabling it', () => {
    const f = managerFixture(), first = f.manager.setup(f.user);
    f.advance(10 * 60_000);
    expect(f.manager.status(f.user.id).pending).toBe(false);
    expect(() => f.manager.enable(f.user.id, f.session.token, totpCode(first.secret, f.now()))).toThrow('Start authenticator setup again');
    const second = f.manager.setup(f.user);
    f.manager.enable(f.user.id, f.session.token, totpCode(second.secret, f.now()));
    expect(() => f.manager.setup(f.user)).toThrow('Disable the current authenticator');
    expect(() => f.manager.disable(f.user.id, f.session.token, 'invalid')).toThrow('unused authenticator or recovery code');
    expect(f.manager.status(f.user.id).enabled).toBe(true);
  });
});

describe('local MFA HTTP and login integration', () => {
  it('protects settings with session, CSRF, origin, local credentials and current password', async () => {
    const f = await apiFixture();
    expect((await f.app.inject({ url: '/api/v1/auth/two-factor' })).statusCode).toBe(401);
    const input = { currentPassword: f.password };
    expect((await f.post('setup', input, { cookie: f.headers.cookie } as typeof f.headers)).statusCode).toBe(403);
    expect((await f.post('setup', input, { ...f.headers, origin: 'https://attacker.test' })).statusCode).toBe(403);
    expect((await f.post('setup', { currentPassword: 'incorrect-password' })).statusCode).toBe(401);
    const central = f.store.createSession(f.user.id, true), centralHeaders = { cookie: `panel_session=${central.token}`, 'x-csrf-token': central.csrfToken };
    expect((await f.app.inject({ url: '/api/v1/auth/two-factor', headers: centralHeaders })).json().available).toBe(false);
    expect((await f.post('setup', input, centralHeaders)).statusCode).toBe(403);
    expect(f.store.db.prepare('SELECT * FROM two_factor_auth').all()).toEqual([]);
  });
  it('enforces local login challenges, consumes recovery codes once, and verifies password before MFA', async () => {
    const f = await apiFixture();
    const setup = await f.post('setup', { currentPassword: f.password }); expect(setup.statusCode).toBe(200);
    const enabled = await f.post('enable', { currentPassword: f.password, code: totpCode(setup.json().secret, Date.now()) });
    expect(enabled.statusCode).toBe(200); expect(enabled.json().recoveryCodes).toHaveLength(10);
    const login = (extra = {}) => f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: f.user.email, password: f.password, ...extra } });
    const missing = await login(); expect(missing.statusCode).toBe(401); expect(missing.json().error.code).toBe('TWO_FACTOR_REQUIRED'); expect(missing.cookies).toEqual([]);
    expect((await login({ password: 'wrong-password' })).json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await login({ totpCode: 'not-an-otp' })).statusCode).toBe(401);
    const code = enabled.json().recoveryCodes[0];
    expect((await login({ totpCode: code })).statusCode).toBe(200);
    expect((await login({ totpCode: code })).statusCode).toBe(401);
    const status = await f.app.inject({ url: '/api/v1/auth/two-factor', headers: f.headers });
    expect(status.json()).toEqual({ available: true, enabled: true, pending: false, recoveryCodesRemaining: 9 });
    expect(status.body).not.toContain(setup.json().secret); expect(status.body).not.toContain(code);
    const disabled = await f.post('disable', { currentPassword: f.password, code: enabled.json().recoveryCodes[1] });
    expect(disabled.statusCode).toBe(200); expect(disabled.json()).toEqual({ enabled: false });
    expect((await login()).statusCode).toBe(200);
  });
  it('refuses to enable or disable without the correct current password', async () => {
    const f = await apiFixture();
    const setup = (await f.post('setup', { currentPassword: f.password })).json();
    const code = totpCode(setup.secret, Date.now());
    expect((await f.post('enable', { currentPassword: 'wrong-password', code })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/v1/auth/two-factor', headers: f.headers })).json().enabled).toBe(false);
    const enabled = (await f.post('enable', { currentPassword: f.password, code })).json();
    expect((await f.post('disable', { currentPassword: 'wrong-password', code: enabled.recoveryCodes[0] })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/v1/auth/two-factor', headers: f.headers })).json().enabled).toBe(true);
  });
  it.each(['session', 'password'] as const)('rechecks %s after asynchronous password verification', async change => {
    const f = await apiFixture();
    let release!: () => void, entered = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = passwords.verifyPassword;
    vi.spyOn(passwords, 'verifyPassword').mockImplementationOnce(async (...args) => { entered = true; await pending; return original(...args); });
    const response = f.post('setup', { currentPassword: f.password }).then(value => value);
    await vi.waitFor(() => expect(entered).toBe(true), { interval: 5 });
    if (change === 'session') f.store.deleteSession(f.token);
    else f.store.db.prepare('UPDATE local_credentials SET password_hash=? WHERE user_id=?').run('changed-after-verification', f.user.id);
    release();
    expect((await response).statusCode).toBe(change === 'session' ? 401 : 409);
    expect(f.store.db.prepare('SELECT * FROM two_factor_auth').all()).toEqual([]);
  });
});

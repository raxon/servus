import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionResponse, User } from '../shared/types.js';
import type { TwoFactorSetup } from '../shared/two-factor.js';
import { matchTotpCounter, newRecoveryCodes, newTotpSecret, recoveryCodeHash } from './totp.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';
import { verifyPassword } from './auth.js';

export const TWO_FACTOR_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS two_factor_auth (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pending_secret TEXT, pending_created_at INTEGER,
  secret TEXT, recovery_hashes TEXT NOT NULL DEFAULT '[]',
  last_counter INTEGER NOT NULL DEFAULT -1,
  enabled_at TEXT, updated_at TEXT NOT NULL,
  CHECK ((secret IS NULL AND enabled_at IS NULL) OR (secret IS NOT NULL AND enabled_at IS NOT NULL))
);`;
const pendingTtlMs = 10 * 60_000;
interface FactorRow {
  user_id: string; pending_secret: string | null; pending_created_at: number | null;
  secret: string | null; recovery_hashes: string; last_counter: number; enabled_at: string | null; updated_at: string;
}
interface TwoFactorOptions {
  store: Store;
  session: (request: FastifyRequest, mutation?: boolean) => SessionResponse;
  manager?: LocalTwoFactor;
}

/** Local-password MFA only. Central identity providers maintain their own MFA. */
export class LocalTwoFactor {
  constructor(private readonly store: Store, private readonly options: { now?: () => number } = {}) {
    store.db.exec(TWO_FACTOR_SCHEMA_SQL);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private row(userId: string) { return this.store.db.prepare('SELECT * FROM two_factor_auth WHERE user_id=?').get(userId) as FactorRow | undefined; }
  private hashes(value: string): string[] {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new AppError('TWO_FACTOR_UNAVAILABLE', 'Authenticator configuration is unavailable', 503); }
    if (!Array.isArray(parsed) || parsed.length > 10 || !parsed.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)))
      throw new AppError('TWO_FACTOR_UNAVAILABLE', 'Authenticator configuration is unavailable', 503);
    return parsed;
  }
  private secret(value: string): string {
    try {
      const secret = this.store.vault.open(value);
      if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('Invalid secret');
      return secret;
    } catch { throw new AppError('TWO_FACTOR_UNAVAILABLE', 'Authenticator configuration is unavailable', 503); }
  }
  status(userId: string) {
    const row = this.row(userId), now = this.now();
    return {
      enabled: Boolean(row?.secret),
      pending: Boolean(row?.pending_secret && row.pending_created_at !== null && row.pending_created_at <= now && row.pending_created_at > now - pendingTtlMs),
      recoveryCodesRemaining: row?.secret ? this.hashes(row.recovery_hashes).length : 0,
    };
  }
  setup(user: User): TwoFactorSetup {
    return this.store.db.transaction(() => {
      if (this.row(user.id)?.secret) throw new AppError('TWO_FACTOR_ENABLED', 'Disable the current authenticator before setting up a replacement', 409);
      const secret = newTotpSecret(), now = this.now(), updated = new Date(now).toISOString();
      this.store.db.prepare(`INSERT INTO two_factor_auth(user_id,pending_secret,pending_created_at,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET pending_secret=excluded.pending_secret,pending_created_at=excluded.pending_created_at,updated_at=excluded.updated_at`)
        .run(user.id, this.store.vault.seal(secret), now, updated);
      this.store.recordAudit(user.id, 'account.two-factor.setup', user.id);
      const uri = new URL(`otpauth://totp/Servus:${encodeURIComponent(user.email)}`);
      for (const [key, value] of Object.entries({ secret, issuer: 'Servus', algorithm: 'SHA1', digits: '6', period: '30' })) uri.searchParams.set(key, value);
      return { secret, uri: uri.href, expiresAt: new Date(now + pendingTtlMs).toISOString() };
    }).immediate();
  }
  private revokeOtherSessions(userId: string, currentToken: string) {
    const tokenHash = createHash('sha256').update(currentToken).digest('hex');
    this.store.db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, tokenHash);
    this.store.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(new Date(this.now()).toISOString(), userId);
  }
  enable(userId: string, currentToken: string, code: string) {
    return this.store.db.transaction(() => {
      const row = this.row(userId), now = this.now();
      if (row?.secret) throw new AppError('TWO_FACTOR_ENABLED', 'Two-factor authentication is already enabled', 409);
      if (!row?.pending_secret || row.pending_created_at === null || row.pending_created_at > now || row.pending_created_at <= now - pendingTtlMs)
        throw new AppError('TWO_FACTOR_SETUP_EXPIRED', 'Start authenticator setup again before enabling it', 409);
      const counter = matchTotpCounter(this.secret(row.pending_secret), code, now);
      if (counter === null) throw new AppError('TWO_FACTOR_CODE_INVALID', 'Enter a current six-digit authenticator code', 401);
      const recoveryCodes = newRecoveryCodes(), hashes = recoveryCodes.map(value => recoveryCodeHash(value)!);
      const timestamp = new Date(now).toISOString();
      this.store.db.prepare(`UPDATE two_factor_auth SET secret=pending_secret,pending_secret=NULL,pending_created_at=NULL,
        recovery_hashes=?,last_counter=?,enabled_at=?,updated_at=? WHERE user_id=?`)
        .run(JSON.stringify(hashes), counter, timestamp, timestamp, userId);
      this.revokeOtherSessions(userId, currentToken);
      this.store.recordAudit(userId, 'account.two-factor.enabled', userId);
      return { enabled: true as const, recoveryCodes };
    }).immediate();
  }
  verifyLogin(userId: string, code?: string): boolean {
    return this.store.db.transaction(() => {
      const row = this.row(userId);
      if (!row?.secret) return true;
      if (!code || code.length > 64) return false;
      if (!Number.isSafeInteger(row.last_counter) || row.last_counter < -1)
        throw new AppError('TWO_FACTOR_UNAVAILABLE', 'Authenticator configuration is unavailable', 503);
      const now = this.now(), counter = matchTotpCounter(this.secret(row.secret), code, now, row.last_counter);
      if (counter !== null) {
        this.store.db.prepare('UPDATE two_factor_auth SET last_counter=?,updated_at=? WHERE user_id=?').run(counter, new Date(now).toISOString(), userId);
        return true;
      }
      const candidate = recoveryCodeHash(code);
      if (!candidate) return false;
      const hashes = this.hashes(row.recovery_hashes);
      const index = hashes.findIndex(hash => timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex')));
      if (index === -1) return false;
      hashes.splice(index, 1);
      this.store.db.prepare('UPDATE two_factor_auth SET recovery_hashes=?,updated_at=? WHERE user_id=?').run(JSON.stringify(hashes), new Date(now).toISOString(), userId);
      this.store.recordAudit(userId, 'account.two-factor.recovery-used', userId);
      return true;
    }).immediate();
  }
  disable(userId: string, currentToken: string, code: string) {
    return this.store.db.transaction(() => {
      if (!this.row(userId)?.secret) throw new AppError('TWO_FACTOR_DISABLED', 'Two-factor authentication is not enabled', 409);
      if (!this.verifyLogin(userId, code)) throw new AppError('TWO_FACTOR_CODE_INVALID', 'Enter an unused authenticator or recovery code', 401);
      this.store.db.prepare('DELETE FROM two_factor_auth WHERE user_id=?').run(userId);
      this.revokeOtherSessions(userId, currentToken);
      this.store.recordAudit(userId, 'account.two-factor.disabled', userId);
      return { enabled: false as const };
    }).immediate();
  }
}

export function registerTwoFactor(app: FastifyInstance, options: TwoFactorOptions) {
  const manager = options.manager ?? new LocalTwoFactor(options.store);
  const prefix = '/api/v1/auth/two-factor';
  const currentPassword = z.string().min(1).max(128);
  const passwordInput = z.object({ currentPassword }).strict();
  const codeInput = z.object({ currentPassword, code: z.string().trim().min(1).max(64) }).strict();
  const rateLimit = { max: 5, timeWindow: '1 minute' };
  async function authorize(request: FastifyRequest, password: string) {
    const { user } = options.session(request, true), token = request.cookies.panel_session;
    const credential = token ? options.store.localCredentialForSession(user.id, token) : undefined;
    if (!credential || !token) throw new AppError('LOCAL_PASSWORD_REQUIRED', 'Sign in with your local password to manage this authenticator', 403);
    if (!await verifyPassword(password, credential.passwordHash)) throw new AppError('INVALID_PASSWORD', 'Current password is incorrect', 401);
    const current = options.session(request, true), fresh = options.store.localCredentialForSession(user.id, token);
    if (current.user.id !== user.id || fresh?.passwordHash !== credential.passwordHash)
      throw new AppError('AUTHENTICATION_CHANGED', 'Your session or password changed. Sign in and try again.', 409);
    return { user: current.user, token };
  }
  app.get(prefix, async request => {
    const { user } = options.session(request);
    const token = request.cookies.panel_session;
    return { available: Boolean(token && options.store.localCredentialForSession(user.id, token)), ...manager.status(user.id) };
  });
  app.post(`${prefix}/setup`, { config: { rateLimit } }, async request => {
    options.session(request, true);
    const input = passwordInput.parse(request.body), auth = await authorize(request, input.currentPassword);
    return manager.setup(auth.user);
  });
  app.post(`${prefix}/enable`, { config: { rateLimit } }, async request => {
    options.session(request, true);
    const input = codeInput.parse(request.body), auth = await authorize(request, input.currentPassword);
    return manager.enable(auth.user.id, auth.token, input.code);
  });
  app.post(`${prefix}/disable`, { config: { rateLimit } }, async request => {
    options.session(request, true);
    const input = codeInput.parse(request.body), auth = await authorize(request, input.currentPassword);
    return manager.disable(auth.user.id, auth.token, input.code);
  });
  return manager;
}

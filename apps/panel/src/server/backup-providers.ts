import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { validateBackupEndpoint } from '../agent/s3-storage.js';
import { validateRemoteDestination } from '../agent/remote-backup-providers.js';
import {
  redactBackupDestination,
  remoteDestinationSchema,
  type BackupDestination,
  type BackupStorageProfile,
  type BackupStorageSelection,
  type RemoteBackupDestination,
} from '../shared/storage-target.js';
import { BACKUP_PROFILES_SCHEMA_SQL } from '../shared/backups.js';
import type { BackupOptions } from './backups.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';

export { BACKUP_PROFILES_SCHEMA_SQL };

export function loadBackupDestination(store: Store, serviceId: string, reference: string): RemoteBackupDestination {
  const record = JSON.parse(store.vault.getServiceSecret(reference, serviceId, 'backup-storage')) as unknown;
  const parsed = z.object({ kind: z.literal('backup-storage-v1'), serviceId: z.literal(serviceId), destination: remoteDestinationSchema }).strict().parse(record);
  return parsed.destination;
}

export function currentBackupDestination(store: Store, serviceId: string): BackupDestination {
  const setting = store.db.prepare('SELECT destination_ref FROM database_backup_settings WHERE service_id=?').get(serviceId) as { destination_ref: string | null } | undefined;
  return setting?.destination_ref ? redactBackupDestination(loadBackupDestination(store, serviceId, setting.destination_ref)) : { type: 'local' };
}

export interface ProfileRow { id: string; name: string; destination_ref: string | null; updated_at: string; active: number }

export function profileDestination(store: Store, row: ProfileRow): RemoteBackupDestination | null {
  if (!row.destination_ref) return null;
  return z.object({ kind: z.literal('backup-global-v1'), destination: remoteDestinationSchema }).strict().parse(JSON.parse(store.vault.get(row.destination_ref))).destination;
}

function publicProfile(store: Store, row: ProfileRow): BackupStorageProfile {
  const destination = profileDestination(store, row);
  return { id: row.id, name: row.name, updatedAt: row.updated_at, destination: destination ? redactBackupDestination(destination) : { type: 'local' } };
}

export function currentBackupSelection(store: Store, serviceId: string): BackupStorageSelection {
  const setting = store.db.prepare('SELECT destination_ref,profile_id FROM database_backup_settings WHERE service_id=?').get(serviceId) as { destination_ref: string | null; profile_id: string | null } | undefined;
  const profile = setting?.profile_id ? store.db.prepare('SELECT name FROM backup_storage_profiles WHERE id=?').get(setting.profile_id) as { name: string } | undefined : undefined;
  return { destination: currentBackupDestination(store, serviceId), profileId: setting?.profile_id ?? null, profileName: profile?.name ?? null, legacy: !!setting?.destination_ref && !setting.profile_id };
}

async function validateDestination(destination: RemoteBackupDestination): Promise<void> {
  if (destination.type === 's3') {
    await validateBackupEndpoint(destination);
  } else {
    await validateRemoteDestination(destination);
  }
}

export function registerBackupProviders(app: FastifyInstance, options: BackupOptions) {
  const prefix = '/api/v1/services/:id/backup-destination';
  const authenticate = (req: Parameters<BackupOptions['serviceAccess']>[0], write = false) => {
    if (!options.session) throw new AppError('UNAUTHORIZED', 'Sign in to continue', 401);
    const auth = options.session(req, write);
    if (write && auth.user.role !== 'admin') throw new AppError('FORBIDDEN', 'Only administrators can manage backup storage profiles.', 403);
    return auth;
  };

  app.get('/api/v1/backup-storage', async (req) => {
    authenticate(req);
    return {
      profiles: (options.store.db.prepare('SELECT * FROM backup_storage_profiles WHERE active=1 ORDER BY name,id').all() as ProfileRow[]).map((row) => publicProfile(options.store, row)),
    };
  });

  const destinationUnion = z.union([z.object({ type: z.literal('local') }).strict(), remoteDestinationSchema]);
  const profileSchema = z.object({ name: z.string().trim().min(1).max(80), destination: destinationUnion }).strict();

  const saveProfile = async (req: FastifyRequest, id: string, create: boolean) => {
    const { store } = options;
    const auth = authenticate(req, true);
    let body = req.body;
    if (!create && body && typeof body === 'object' && 'destination' in body && body.destination && typeof body.destination === 'object' && 'type' in body.destination) {
      const previous = store.db.prepare('SELECT * FROM backup_storage_profiles WHERE id=? AND active=1').get(id) as ProfileRow | undefined;
      const saved = previous ? profileDestination(store, previous) : null;
      const draft = body.destination as Record<string, unknown>;
      if (saved && saved.type === 's3' && draft.type === 's3') {
        const sameEndpoint = draft.endpoint === saved.endpoint && draft.provider === saved.provider;
        if (!sameEndpoint && (!draft.accessKeyId || !draft.secretAccessKey)) throw new AppError('BACKUP_CREDENTIALS_REQUIRED', 'Enter both credentials when changing the endpoint or provider.', 400);
        if (sameEndpoint) {
          body = {
            ...body,
            destination: {
              ...draft,
              accessKeyId: draft.accessKeyId === undefined || draft.accessKeyId === '' ? saved.accessKeyId : draft.accessKeyId,
              secretAccessKey: draft.secretAccessKey === undefined || draft.secretAccessKey === '' ? saved.secretAccessKey : draft.secretAccessKey,
            },
          };
        }
      } else if (saved && saved.type === 'sftp' && draft.type === 'sftp' && draft.host === saved.host) {
        body = {
          ...body,
          destination: {
            ...draft,
            ...(draft.password ? {} : saved.password ? { password: saved.password } : {}),
            ...(draft.privateKey ? {} : saved.privateKey ? { privateKey: saved.privateKey } : {}),
          },
        };
      } else if (saved && saved.type === 'ftp' && draft.type === 'ftp' && draft.host === saved.host && !draft.password) {
        body = { ...body, destination: { ...draft, password: saved.password } };
      } else if (saved && saved.type === 'gdrive' && draft.type === 'gdrive' && !draft.accessToken && !draft.refreshToken) {
        body = {
          ...body,
          destination: {
            ...draft,
            ...(saved.accessToken ? { accessToken: saved.accessToken } : {}),
            ...(saved.refreshToken ? { refreshToken: saved.refreshToken } : {}),
            ...(saved.clientId ? { clientId: saved.clientId } : {}),
            ...(saved.clientSecret ? { clientSecret: saved.clientSecret } : {}),
          },
        };
      } else if (saved && saved.type === 'dropbox' && draft.type === 'dropbox' && !draft.accessToken && !draft.refreshToken) {
        body = {
          ...body,
          destination: {
            ...draft,
            ...(saved.accessToken ? { accessToken: saved.accessToken } : {}),
            ...(saved.refreshToken ? { refreshToken: saved.refreshToken } : {}),
            ...(saved.appKey ? { appKey: saved.appKey } : {}),
            ...(saved.appSecret ? { appSecret: saved.appSecret } : {}),
          },
        };
      }
    }

    const input = profileSchema.parse(body);
    if (!create && !store.db.prepare('SELECT 1 FROM backup_storage_profiles WHERE id=? AND active=1').get(id)) throw new AppError('NOT_FOUND', 'Backup storage profile not found.', 404);
    if (input.destination.type !== 'local') {
      try {
        await validateDestination(input.destination);
      } catch (error) {
        throw new AppError('BACKUP_ENDPOINT', error instanceof Error ? error.message : 'Invalid backup storage destination.', 400);
      }
    }
    authenticate(req, true);
    if (!create && !store.db.prepare('SELECT 1 FROM backup_storage_profiles WHERE id=? AND active=1').get(id)) throw new AppError('NOT_FOUND', 'Backup storage profile not found.', 404);
    return store.db.transaction(() => {
      const reference = input.destination.type !== 'local' ? store.vault.put(JSON.stringify({ kind: 'backup-global-v1', destination: input.destination })) : null;
      store.db.prepare('INSERT INTO backup_storage_profiles(id,name,destination_ref,updated_at,active) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,destination_ref=excluded.destination_ref,updated_at=excluded.updated_at').run(id, input.name, reference, new Date().toISOString());
      store.recordAudit(auth.user.id, 'backup.storage.saved', id);
      return { profile: publicProfile(store, store.db.prepare('SELECT * FROM backup_storage_profiles WHERE id=?').get(id) as ProfileRow) };
    }).immediate();
  };

  app.post('/api/v1/backup-storage', async (req, reply) => reply.code(201).send(await saveProfile(req, randomUUID(), true)));
  app.put<{ Params: { profileId: string } }>('/api/v1/backup-storage/:profileId', async (req) => saveProfile(req, z.string().uuid().parse(req.params.profileId), false));
  app.delete<{ Params: { profileId: string } }>('/api/v1/backup-storage/:profileId', async (req) => {
    const auth = authenticate(req, true);
    const id = z.string().uuid().parse(req.params.profileId);
    options.store.db.transaction(() => {
      options.store.db.prepare('UPDATE backup_storage_profiles SET active=0 WHERE id=?').run(id);
      options.store.recordAudit(auth.user.id, 'backup.storage.removed', id);
    }).immediate();
    return { success: true };
  });

  app.get<{ Params: { id: string } }>(prefix, async (req) => {
    const { service } = options.serviceAccess(req, req.params.id);
    return currentBackupSelection(options.store, service.id);
  });

  app.put<{ Params: { id: string } }>(prefix, async (req) => {
    const { service, auth } = options.serviceAccess(req, req.params.id, true);
    const { store } = options;
    if (!['postgres', 'mariadb', 'redis', 'mysql', 'mongodb'].includes(service.kind ?? '')) throw new AppError('BACKUP_DATABASE_REQUIRED', 'Backup storage is available for managed databases.', 400);
    if (req.body && typeof req.body === 'object' && 'profileId' in req.body) {
      const { profileId } = z.object({ profileId: z.string().uuid().nullable() }).strict().parse(req.body);
      const profile = profileId ? store.db.prepare('SELECT * FROM backup_storage_profiles WHERE id=? AND active=1').get(profileId) as ProfileRow | undefined : undefined;
      if (profileId && !profile) throw new AppError('BACKUP_PROFILE_NOT_FOUND', 'Choose an available backup storage profile.', 400);
      const destination = profile ? profileDestination(store, profile) : null;
      store.db.transaction(() => {
        const now = new Date().toISOString();
        const reference = destination ? store.putBackupDestinationSecret(service.id, JSON.stringify({ kind: 'backup-storage-v1', serviceId: service.id, destination })) : null;
        store.db.prepare(`INSERT INTO database_backup_settings (service_id,actor_id,enabled,cron,retention,last_tick,updated_at,destination_ref,profile_id) VALUES (?,?,0,'0 2 * * *',7,?,?,?,?) ON CONFLICT(service_id) DO UPDATE SET destination_ref=excluded.destination_ref,profile_id=excluded.profile_id,updated_at=excluded.updated_at`).run(service.id, auth.user.id, now.slice(0, 16), now, reference, profileId);
        store.recordAudit(auth.user.id, 'database.backup.destination', service.id);
      }).immediate();
      return currentBackupSelection(store, service.id);
    }
    const destination = destinationUnion.parse(req.body);
    if (destination.type !== 'local') {
      try {
        await validateDestination(destination);
      } catch (error) {
        throw new AppError('BACKUP_ENDPOINT', error instanceof Error ? error.message : 'Invalid backup endpoint.', 400);
      }
    }
    options.serviceAccess(req, req.params.id, true);
    store.db.transaction(() => {
      const now = new Date().toISOString();
      const reference = destination.type === 'local' ? null : store.putBackupDestinationSecret(service.id, JSON.stringify({ kind: 'backup-storage-v1', serviceId: service.id, destination }));
      store.db.prepare(`INSERT INTO database_backup_settings (service_id,actor_id,enabled,cron,retention,last_tick,updated_at,destination_ref) VALUES (?,?,0,'0 2 * * *',7,?,?,?) ON CONFLICT(service_id) DO UPDATE SET destination_ref=excluded.destination_ref,profile_id=NULL,updated_at=excluded.updated_at`).run(service.id, auth.user.id, now.slice(0, 16), now, reference);
      store.recordAudit(auth.user.id, 'database.backup.destination', service.id);
    }).immediate();
    return { destination: currentBackupDestination(store, service.id) };
  });
}

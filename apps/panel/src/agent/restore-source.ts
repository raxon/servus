import Database from 'better-sqlite3';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { SecretVault } from '../shared/secrets.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/);
const snapshotSchema = z.object({id:z.string().uuid(),projectId:z.string().uuid(),kind:z.enum(['postgres','mariadb']),database:z.object({database:identifier,user:identifier,passwordSecretRef:z.string().uuid()})});

/** Bind preparation to the last successful deployment and its service-owned secrets. */
export function loadRestoreSource(options:{dataDir:string;serviceId:string;kind:'postgres'|'mariadb';vault:SecretVault}):{database:string;user:string;password:string;rootPassword?:string} {
  if (!z.string().uuid().safeParse(options.serviceId).success) throw new Error('Invalid restore service identity.');
  const db = new Database(join(options.dataDir,'panel.sqlite'),{readonly:true,fileMustExist:true});
  let snapshot: z.infer<typeof snapshotSchema>;
  try {
    if (db.pragma('user_version',{simple:true}) !== 5) throw new Error('Unsupported panel database schema.');
    const service = db.prepare('SELECT project_id,deployed_revision,state,deleted_at FROM services WHERE id=?').get(options.serviceId) as {project_id:string;deployed_revision:number|null;state:string;deleted_at:string|null}|undefined;
    if (!service || service.deleted_at || service.deployed_revision === null || service.state !== 'running' || db.prepare("SELECT 1 FROM jobs WHERE service_id=? AND status IN ('queued','running') LIMIT 1").get(options.serviceId)) throw new Error('Database service is not ready for restoration.');
    const deployed = db.prepare("SELECT j.snapshot FROM jobs j JOIN actions a ON a.id=j.action_id WHERE j.service_id=? AND a.type='deploy' AND a.status='succeeded' ORDER BY a.finished_at DESC,a.rowid DESC LIMIT 1").get(options.serviceId) as {snapshot:string}|undefined;
    if (!deployed) throw new Error('Confirmed database deployment is unavailable.');
    snapshot = snapshotSchema.parse(JSON.parse(deployed.snapshot));
    if (snapshot.id !== options.serviceId || snapshot.projectId !== service.project_id || snapshot.kind !== options.kind) throw new Error('Confirmed database identity does not match.');
  } finally { db.close(); }
  const password = options.vault.getServiceSecret(snapshot.database.passwordSecretRef,options.serviceId,'database');
  if (options.kind === 'postgres') return {database:snapshot.database.database,user:snapshot.database.user,password};
  const directory = join(options.dataDir,'database-roots'), path = join(directory,options.serviceId), uid = process.getuid?.();
  const dir = lstatSync(directory), file = lstatSync(path);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 || (uid !== undefined && dir.uid !== uid) || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600 || (uid !== undefined && file.uid !== uid)) throw new Error('Database root identity cannot be verified.');
  const rootPassword = options.vault.getDatabaseRootSecret(readFileSync(path,'utf8'));
  return {database:snapshot.database.database,user:snapshot.database.user,password,rootPassword};
}

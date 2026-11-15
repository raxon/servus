import { createReadStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import Docker from '/app/node_modules/dockerode/lib/docker.js';

const { DatabaseImportError, importDatabaseCandidate } = await import(process.env.SERVUS_IMPORT_MODULE);
const { RestoreJournal } = await import(process.env.SERVUS_IMPORT_JOURNAL);
const { prepareRestoreCandidate } = await import(process.env.SERVUS_IMPORT_PREPARATION);
const { createRestoreCandidate } = await import(process.env.SERVUS_IMPORT_CANDIDATE);
const { stageRestoreArchive, readRestoreArchive } = await import(process.env.SERVUS_IMPORT_ARCHIVE);
const { SecretVault } = await import(process.env.SERVUS_IMPORT_SECRETS);
const db = new Database(':memory:');
db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');
const journal = new RestoreJournal(db, () => false), operationId = process.env.SERVUS_IMPORT_OPERATION;
const serviceId = '11111111-1111-4111-8111-111111111111', kind = process.env.SERVUS_IMPORT_KIND;
const dataDir = mkdtempSync('/tmp/restore-e2e-'), password = readFileSync('/fixture-password', 'utf8');
let vault = new SecretVault(dataDir);
await stageRestoreArchive({ dataDir, operationId, key: vault.restoreArchiveKey(operationId), input: () => createReadStream('/fixture-data') });
vault = new SecretVault(dataDir);
const archive = `${dataDir}/restore-archives/${operationId}.enc`;
if (process.env.SERVUS_IMPORT_TAMPER === '1') { const bytes = readFileSync(archive); bytes[20] ^= 1; writeFileSync(archive, bytes); }
journal.reserve({ id: operationId, serviceId, kind, archiveSha256: process.env.SERVUS_IMPORT_SHA256 });
const target = containerId => ({ containerId, dockerSocket: '/var/run/docker.sock', database: 'fixture', user: 'fixture', input: () => readRestoreArchive({ dataDir, operationId, key: vault.restoreArchiveKey(operationId) }) });
const allocation = process.env.SERVUS_IMPORT_EXISTING
  ? { target: target(process.env.SERVUS_IMPORT_EXISTING) }
  : { allocateTarget: async () => {
      const candidate = await createRestoreCandidate({ docker: new Docker({ socketPath: '/var/run/docker.sock' }), dockerSocket: '/var/run/docker.sock', journal, operationId, serviceId, kind, sourceContainerId: process.env.SERVUS_IMPORT_SOURCE_ID, database: 'fixture', user: 'fixture', password, ...(kind === 'mariadb' ? { rootPassword: password } : {}) });
      return target(candidate.containerId);
    } };
try {
  const result = await prepareRestoreCandidate({ journal, operationId, serviceId, importCandidate: importDatabaseCandidate, ...allocation });
  if (result.phase !== 'prepared') throw new Error('Candidate is not prepared');
} catch (error) {
  process.exitCode = error instanceof DatabaseImportError && journal.get(operationId)?.phase === 'discarding_candidate' ? 12 : 2;
} finally { db.close(); }

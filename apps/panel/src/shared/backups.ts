export type DatabaseBackupStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'deleted';
export interface DatabaseBackup {
  id: string;
  serviceId: string;
  name: string;
  status: DatabaseBackupStatus;
  trigger: 'manual' | 'scheduled';
  createdAt: string;
  finishedAt: string | null;
  size: number | null;
  sha256: string | null;
  extension: 'dump' | 'sql' | 'rdb' | null;
  error: string | null;
  destination: 'local' | 's3';
}
export interface DatabaseBackupSettings {
  enabled: boolean;
  cron: string;
  retention: number;
  timeZone: 'UTC';
  description: string;
}

export const BACKUP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS database_backup_settings (
    service_id TEXT PRIMARY KEY REFERENCES services(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    cron TEXT NOT NULL,
    retention INTEGER NOT NULL CHECK(retention BETWEEN 1 AND 100),
    last_tick TEXT,
    updated_at TEXT NOT NULL,
    destination_ref TEXT
  );
  CREATE TABLE IF NOT EXISTS database_backups (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','deleted')),
    trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    size INTEGER,
    sha256 TEXT,
    extension TEXT,
    error TEXT,
    owner_id TEXT,
    lease_until TEXT,
    destination_ref TEXT,
    object_key TEXT,
    UNIQUE(actor_id,service_id,idempotency_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS database_backup_active_service
    ON database_backups(service_id) WHERE status IN ('queued','running');
  CREATE INDEX IF NOT EXISTS database_backup_service_created ON database_backups(service_id,created_at);
`;

const ranges = [[0,59],[0,23],[1,31],[1,12],[0,7]] as const;
function cronField(field: string, minimum: number, maximum: number): Set<number> {
  const values = new Set<number>();
  for (const entry of field.split(',')) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(entry);
    if (!match) throw new Error('Use a five-field numeric cron expression, for example 0 2 * * *.');
    const step = match[2] ? Number(match[2]) : 1;
    if (step < 1 || step > maximum - minimum + 1) throw new Error('Cron steps are outside the supported range.');
    const [startText, endText] = match[1]!.split('-');
    const start = startText === '*' ? minimum : Number(startText);
    const end = startText === '*' ? maximum : endText !== undefined ? Number(endText) : match[2] ? maximum : start;
    if (start < minimum || start > maximum || end < start || end > maximum) throw new Error('Cron values are outside the supported range.');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseBackupCron(expression: string): Set<number>[] {
  if (expression.length > 128) throw new Error('The backup schedule is too long.');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Use five cron fields: minute, hour, day, month, weekday. Backups run at most once per minute.');
  return fields.map((field, index) => {const range=ranges[index]!;return cronField(field,range[0],range[1]);});
}

export function backupCronMatches(expression: string, date: Date): boolean {
  const [minutes, hours, days, months, weekdays] = parseBackupCron(expression);
  if (!minutes!.has(date.getUTCMinutes()) || !hours!.has(date.getUTCHours()) || !months!.has(date.getUTCMonth()+1)) return false;
  const fields = expression.trim().split(/\s+/);
  const day = days!.has(date.getUTCDate());
  const weekday = weekdays!.has(date.getUTCDay()) || date.getUTCDay() === 0 && weekdays!.has(7);
  // Standard cron joins restricted day-of-month and weekday fields with OR.
  return fields[2] === '*' ? weekday : fields[4] === '*' ? day : day || weekday;
}

export function describeBackupCron(expression: string): string {
  parseBackupCron(expression);
  const fields = expression.trim().split(/\s+/);
  if (fields.every(field => field === '*')) return 'Every minute (UTC)';
  if (/^\*\/\d+$/.test(fields[0]!) && fields.slice(1).every(field => field === '*')) return `Every ${fields[0]!.slice(2)} minutes (UTC)`;
  if (/^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!) && fields.slice(2).every(field => field === '*')) return `Every day at ${fields[1]!.padStart(2,'0')}:${fields[0]!.padStart(2,'0')} UTC`;
  const labels = ['Minutes', 'hours', 'days of month', 'months', 'weekdays (0/7 = Sunday)'];
  return fields.map((field, index) => `${labels[index]}: ${field === '*' ? 'every' : field}`).join('; ') + ' (UTC)';
}

import type { Store } from './store.js';
import type { Service } from '../shared/types.js';
import { AppError } from './errors.js';

/** Saved, pending and potentially live listeners remain reserved until reconciled. */
export function reservedDatabasePorts(store: Store, excludeServiceId?: string): Set<number> {
  const ports = new Set<number>();
  const reserve = (service: Service) => { if (service.databaseAccess?.enabled) ports.add(service.databaseAccess.publishedPort); };
  for (const service of store.listServices()) {
    if (service.id === excludeServiceId) continue;
    reserve(service);
    const rows = store.db.prepare(`SELECT j.snapshot,a.status FROM jobs j JOIN actions a ON a.id=j.action_id
      WHERE j.service_id=? AND a.type='deploy' AND a.status IN ('queued','running','succeeded','failed') ORDER BY a.rowid DESC`).all(service.id) as {snapshot: string; status: string}[];
    let deployedFound = false;
    for (const row of rows) {
      const snapshot = JSON.parse(row.snapshot) as Service;
      const active = row.status === 'queued' || row.status === 'running';
      const uncertain = row.status === 'failed' && !deployedFound;
      const deployed = !deployedFound && row.status === 'succeeded' && snapshot.revision === service.deployedRevision;
      if (active || uncertain || deployed) reserve(snapshot);
      if (deployed) deployedFound = true;
    }
  }
  return ports;
}

/** Called inside the configuration transaction, so two saves cannot claim one port. */
export function assertDatabasePortAvailable(store: Store, candidate: Service): void {
  if (!candidate.databaseAccess?.enabled) return;
  const port = candidate.databaseAccess.publishedPort;
  if (reservedDatabasePorts(store, candidate.id).has(port)) throw new AppError('DATABASE_PORT_CONFLICT', 'This TCP port is reserved by another saved, deployed or pending service', 409);
}

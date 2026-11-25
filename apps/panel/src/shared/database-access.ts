import { z } from 'zod';

// Keep management, Docker and Swarm listeners separate from database access.
const reservedPorts = new Set([2375, 2376, 2377, 4180, 4181, 4182, 4789, 7946]);
export function databasePortAllowed(port: number, panelPort = 4180): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !reservedPorts.has(port) && port !== panelPort;
}
export const databaseAccessSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), publishedPort: z.number().int().refine(port => databasePortAllowed(port), 'Use an available TCP port from 1024 to 65535 outside management and Swarm ports') }).strict(),
]);
export type DatabaseAccess = z.infer<typeof databaseAccessSchema>;
export function normalizedDatabaseAccess(value?: DatabaseAccess): DatabaseAccess { return value?.enabled ? value : { enabled: false }; }
export function databaseTargetPort(kind: string | undefined): number {
  if (kind === 'postgres') return 5432;
  if (kind === 'mariadb' || kind === 'mysql') return 3306;
  if (kind === 'redis') return 6379;
  if (kind === 'mongodb') return 27017;
  throw new Error('External TCP access is available only for managed databases.');
}
export interface DatabaseNetworkStatus { aliases: string[]; publishedPort: number | null; revision: number }

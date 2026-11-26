export type EphemeralDbToolKind = 'adminer' | 'mongo-express' | 'redis-commander';

export interface EphemeralDbToolSession {
  active: boolean;
  serviceId: string;
  tool?: EphemeralDbToolKind;
  hostname?: string;
  url?: string;
  username?: string;
  password?: string; // Returned only once on creation
  startedAt?: string;
  expiresAt?: string;
  ttlMinutes?: number;
}

export interface PostgresMigrationResult {
  sourceServiceId: string;
  targetServiceId: string;
  targetServiceName: string;
  targetImage: string;
  dumpSizeBytes: number;
  dumpSha256: string;
  verified: boolean;
  completedAt: string;
}

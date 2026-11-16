import { z } from 'zod';

export const hostDomainPattern = /^[a-z0-9]{16}\.host\.servus\.run$/;
export const hostConnectionSchema = z.object({
  kind:z.literal('servus-host-v1'),machineId:z.string().uuid(),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  apiOrigin:z.string().url(),enabled:z.boolean(),ready:z.boolean(),
  hostname:z.string().regex(hostDomainPattern).optional(),ip:z.string().optional(),
  dnsStatus:z.enum(['pending','ready']).optional(),certificateExpiresAt:z.string().datetime().optional(),staging:z.boolean().optional(),
  lastSyncAt:z.string().datetime().optional(),lastAttemptAt:z.string().datetime().optional(),lastError:z.string().max(300).optional(),
}).strict();
export type HostConnection = z.infer<typeof hostConnectionSchema>;
export type HostDomainStatus = {available:boolean;enabled:boolean;ready:boolean;hostname?:string;ip?:string;dnsStatus?:'pending'|'ready';certificateExpiresAt?:string;staging?:boolean;lastSyncAt?:string;lastError?:string;busy:boolean};
export const hostCertificateSchema = z.object({hostname:z.string().regex(hostDomainPattern),certificate:z.string().min(1).max(32768),privateKey:z.string().min(1).max(16384),expiresAt:z.string().datetime(),staging:z.boolean()}).strict();
export type HostCertificate = z.infer<typeof hostCertificateSchema>;

export function isHostApplication(hostname:string,base:string):boolean {
  return hostDomainPattern.test(base) && hostname.endsWith(`.${base}`) && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname.slice(0,-base.length-1));
}

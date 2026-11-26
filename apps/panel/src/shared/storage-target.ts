import { z } from 'zod';

const safePrefixSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._/-]*$/)
  .refine((value) => !value.startsWith('/') && !value.split('/').some((part) => part === '.' || part === '..'))
  .transform((value) => value.replace(/\/+$/, ''));

const hostnameOrIp = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, 'Enter a valid server hostname or IP address');

export const s3DestinationSchema = z.object({
  type: z.literal('s3'),
  provider: z.enum(['s3', 'r2']),
  endpoint: z.string().url().max(512),
  region: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  bucket: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/).refine((value) => !value.includes('..')),
  prefix: safePrefixSchema,
  storageClass: z.enum(['STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING', 'GLACIER_IR']).default('STANDARD'),
  accessKeyId: z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f]+$/),
  secretAccessKey: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/),
}).strict();

export const sftpDestinationSchema = z.object({
  type: z.literal('sftp'),
  host: hostnameOrIp,
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128).regex(/^[^\x00-\x20\x7f]+$/),
  password: z.string().min(1).max(4096).optional(),
  privateKey: z.string().min(32).max(16384).optional(),
  path: safePrefixSchema.default('backups'),
}).strict().refine((v) => Boolean(v.password || v.privateKey), 'Enter an SFTP password or private key');

export const ftpDestinationSchema = z.object({
  type: z.literal('ftp'),
  host: hostnameOrIp,
  port: z.number().int().min(1).max(65535).default(21),
  username: z.string().min(1).max(128).regex(/^[^\x00-\x20\x7f]+$/),
  password: z.string().min(1).max(4096),
  tls: z.boolean().default(true),
  path: safePrefixSchema.default('backups'),
}).strict();

export const gdriveDestinationSchema = z.object({
  type: z.literal('gdrive'),
  folderId: z.string().min(4).max(200).regex(/^[A-Za-z0-9._-]+$/),
  accessToken: z.string().min(8).max(4096).optional(),
  refreshToken: z.string().min(8).max(4096).optional(),
  clientId: z.string().min(4).max(256).optional(),
  clientSecret: z.string().min(4).max(512).optional(),
}).strict().refine(
  (v) => Boolean(v.accessToken || (v.refreshToken && v.clientId && v.clientSecret)),
  'Provide a Google Drive access token or OAuth refresh token with client ID and secret',
);

export const dropboxDestinationSchema = z.object({
  type: z.literal('dropbox'),
  path: safePrefixSchema.default('backups'),
  accessToken: z.string().min(8).max(4096).optional(),
  refreshToken: z.string().min(8).max(4096).optional(),
  appKey: z.string().min(4).max(256).optional(),
  appSecret: z.string().min(4).max(512).optional(),
}).strict().refine(
  (v) => Boolean(v.accessToken || (v.refreshToken && v.appKey && v.appSecret)),
  'Provide a Dropbox access token or OAuth refresh token with app key and secret',
);

export const remoteDestinationSchema = z.discriminatedUnion('type', [
  s3DestinationSchema,
  sftpDestinationSchema,
  ftpDestinationSchema,
  gdriveDestinationSchema,
  dropboxDestinationSchema,
]);

export type S3Destination = z.infer<typeof s3DestinationSchema>;
export type SftpDestination = z.infer<typeof sftpDestinationSchema>;
export type FtpDestination = z.infer<typeof ftpDestinationSchema>;
export type GdriveDestination = z.infer<typeof gdriveDestinationSchema>;
export type DropboxDestination = z.infer<typeof dropboxDestinationSchema>;
export type RemoteBackupDestination = z.infer<typeof remoteDestinationSchema>;

export type BackupDestination =
  | { type: 'local' }
  | (Omit<S3Destination, 'accessKeyId' | 'secretAccessKey'> & { credentialsConfigured: true })
  | (Omit<SftpDestination, 'password' | 'privateKey'> & { credentialsConfigured: true })
  | (Omit<FtpDestination, 'password'> & { credentialsConfigured: true })
  | (Omit<GdriveDestination, 'accessToken' | 'refreshToken' | 'clientSecret'> & { credentialsConfigured: true })
  | (Omit<DropboxDestination, 'accessToken' | 'refreshToken' | 'appSecret'> & { credentialsConfigured: true });

export function destinationPrefix(value: RemoteBackupDestination): string {
  if (value.type === 's3') return value.prefix;
  if (value.type === 'gdrive') return '';
  return value.path;
}

export function redactBackupDestination(value: RemoteBackupDestination): BackupDestination {
  if (value.type === 's3') {
    const { accessKeyId: _a, secretAccessKey: _s, ...safe } = value;
    return { ...safe, credentialsConfigured: true };
  }
  if (value.type === 'sftp') {
    const { password: _p, privateKey: _k, ...safe } = value;
    return { ...safe, credentialsConfigured: true };
  }
  if (value.type === 'ftp') {
    const { password: _p, ...safe } = value;
    return { ...safe, credentialsConfigured: true };
  }
  if (value.type === 'gdrive') {
    const { accessToken: _a, refreshToken: _r, clientSecret: _c, ...safe } = value;
    return { ...safe, credentialsConfigured: true };
  }
  const { accessToken: _a, refreshToken: _r, appSecret: _s, ...safe } = value;
  return { ...safe, credentialsConfigured: true };
}

export interface BackupStorageProfile {
  id: string;
  name: string;
  destination: BackupDestination;
  updatedAt: string;
}

export interface BackupStorageSelection {
  destination: BackupDestination;
  profileId: string | null;
  profileName: string | null;
  legacy: boolean;
}

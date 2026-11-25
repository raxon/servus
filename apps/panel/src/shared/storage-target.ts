import { z } from 'zod';

export const s3DestinationSchema=z.object({
  type:z.literal('s3'),
  provider:z.enum(['s3','r2']),
  endpoint:z.string().url().max(512),
  region:z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  bucket:z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/).refine(value=>!value.includes('..')),
  prefix:z.string().max(200).regex(/^[A-Za-z0-9._/-]*$/).refine(value=>!value.startsWith('/')&&!value.split('/').some(part=>part==='.'||part==='..')).transform(value=>value.replace(/\/+$/,'')),
  storageClass:z.enum(['STANDARD','STANDARD_IA','ONEZONE_IA','INTELLIGENT_TIERING','GLACIER_IR']).default('STANDARD'),
  accessKeyId:z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f]+$/),
  secretAccessKey:z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/),
}).strict();
export type S3Destination=z.infer<typeof s3DestinationSchema>;
export type BackupDestination={type:'local'}|Omit<S3Destination,'accessKeyId'|'secretAccessKey'> & {credentialsConfigured:true};
export function redactBackupDestination(value:S3Destination):BackupDestination {
  const {accessKeyId:_access,secretAccessKey:_secret,...safe}=value;
  return {...safe,credentialsConfigured:true};
}

export interface BackupStorageProfile {
  id:string;
  name:string;
  destination:BackupDestination;
  updatedAt:string;
}
export interface BackupStorageSelection {
  destination:BackupDestination;
  profileId:string|null;
  profileName:string|null;
  legacy:boolean;
}

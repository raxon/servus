import { z } from 'zod';
import { signSupervisorRoleMessage } from '../shared/supervisor-control.js';

export const installationBackupId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const installationBackupName = z.string().max(200).refine(value =>
  Array.from(value).length >= 1 && Array.from(value).length <= 100 && value === value.trim() &&
  !/^[\u0085]|[\u0085]$/u.test(value) && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value));
export const installationBackupInputSchema = z.strictObject({operationId: installationBackupId, name: installationBackupName});
export const installationBackupApprovalFieldsSchema = installationBackupInputSchema.extend({
  actorId: installationBackupId, issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const installationBackupApprovalSchema = installationBackupApprovalFieldsSchema.extend({version: z.literal(1), proof: z.string().regex(/^[a-f0-9]{64}$/)});
export type InstallationBackupApprovalFields = z.infer<typeof installationBackupApprovalFieldsSchema>;
export type InstallationBackupApproval = z.infer<typeof installationBackupApprovalSchema>;

/** Match installation-backups.py's fixed UTF-8 representation, including NUL separators. */
export function installationBackupApprovalMessage(input: InstallationBackupApprovalFields): string {
  const value = installationBackupApprovalFieldsSchema.parse(input);
  return `servus-installation-backup-v1\0${value.operationId}\0${value.actorId}\0${value.issuedAt}\0${value.name}`;
}

export function signInstallationBackupApproval(input: InstallationBackupApprovalFields, secretPath: string): InstallationBackupApproval {
  const value = installationBackupApprovalFieldsSchema.parse(input);
  return {...value, version: 1, proof: signSupervisorRoleMessage(secretPath, installationBackupApprovalMessage(value))};
}

/** Cancellation receipts cannot authorize creating or resuming an installation backup. */
export function installationBackupCancellationMessage(input:InstallationBackupApprovalFields):string{
  const value=installationBackupApprovalFieldsSchema.parse(input);
  return `servus-installation-backup-cancel-v1\0${value.operationId}\0${value.actorId}\0${value.issuedAt}\0${value.name}`;
}
export function signInstallationBackupCancellation(input:InstallationBackupApprovalFields,secretPath:string):InstallationBackupApproval{
  const value=installationBackupApprovalFieldsSchema.parse(input);
  return{...value,version:1,proof:signSupervisorRoleMessage(secretPath,installationBackupCancellationMessage(value))};
}

/** Deletion receipts cannot authorize creating, resuming or cancelling an installation backup. */
export function installationBackupDeletionMessage(input:InstallationBackupApprovalFields):string{
  const value=installationBackupApprovalFieldsSchema.parse(input);
  return `servus-installation-backup-delete-v1\0${value.operationId}\0${value.actorId}\0${value.issuedAt}\0${value.name}`;
}
export function signInstallationBackupDeletion(input:InstallationBackupApprovalFields,secretPath:string):InstallationBackupApproval{
  const value=installationBackupApprovalFieldsSchema.parse(input);
  return{...value,version:1,proof:signSupervisorRoleMessage(secretPath,installationBackupDeletionMessage(value))};
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import {
  installationBackupApprovalSchema, installationBackupId, installationBackupInputSchema,
  signInstallationBackupApproval, signInstallationBackupCancellation, type InstallationBackupApproval, type InstallationBackupApprovalFields,
} from './installation-backup-approval.js';
import { cancelInstallationBackup, installationBackupCapability, installationBackupStatus, submitInstallationBackup, UpdaterClientError } from './updater-client.js';

export interface InstallationBackupRoutesOptions {
  administrator: (request: FastifyRequest, mutation?: boolean) => {id: string};
  socketPath?: string;
  applyEnabled?: boolean;
  approvalSecretPath?: string;
  signApproval?: (input: InstallationBackupApprovalFields) => InstallationBackupApproval;
  signCancellation?: (input: InstallationBackupApprovalFields) => InstallationBackupApproval;
  now?: () => number;
}

function backupError(error: unknown): never {
  if (error instanceof UpdaterClientError && error.certainty === 'definitive') {
    if (error.code === 'not_found') throw new AppError('NOT_FOUND', 'Installation backup operation not found', 404);
    if (['idempotency_conflict', 'operation_in_progress', 'recovery_required'].includes(error.code))
      throw new AppError('INSTALLATION_BACKUP_CONFLICT', 'The backup cannot proceed in its current state', 409);
    if (error.code === 'invalid_input' || error.code === 'invalid_request')
      throw new AppError('INVALID_INSTALLATION_BACKUP', 'The installation backup request is invalid', 400);
  }
  throw new AppError('INSTALLATION_BACKUP_UNAVAILABLE', error instanceof UpdaterClientError && error.certainty === 'uncertain'
    ? 'The backup outcome is unknown. Check its status before retrying.' : 'Installation backups are unavailable', 503);
}

/** Installation snapshots require the browser administrator session and host opt-in. */
export function registerInstallationBackups(app: FastifyInstance, options: InstallationBackupRoutesOptions) {
  function administrator(request: FastifyRequest, mutation = false) {
    if (request.headers.authorization !== undefined) throw new AppError('UNAUTHORIZED', 'Sign in with an administrator session', 401);
    return options.administrator(request, mutation);
  }
  function endpoint() {
    if (!options.applyEnabled || !options.socketPath || (!options.approvalSecretPath && !options.signApproval))
      throw new AppError('INSTALLATION_BACKUP_UNAVAILABLE', 'Installation backups are unavailable', 503);
    return {socketPath: options.socketPath};
  }

  app.get('/api/v1/installation-backups',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>{
    administrator(request);z.strictObject({}).parse(request.query);
    if(!options.applyEnabled||!options.socketPath||(!options.approvalSecretPath&&!options.signApproval))return{available:false,reason:'not_configured'};
    const capability=await installationBackupCapability({socketPath:options.socketPath});
    administrator(request);return capability;
  });

  app.post('/api/v1/installation-backups', {bodyLimit: 2048, config: {rateLimit: {max: 5, timeWindow: '1 minute'}}}, async (request, reply) => {
    const actor = administrator(request, true);
    const input = installationBackupInputSchema.parse(request.body);
    z.strictObject({}).parse(request.query);
    const socket = endpoint();
    let approval: InstallationBackupApproval;
    try {
      const fields = {...input, actorId: actor.id, issuedAt: (options.now ?? Date.now)()};
      approval = installationBackupApprovalSchema.parse(options.signApproval
        ? options.signApproval(fields) : signInstallationBackupApproval(fields, options.approvalSecretPath!));
      if (approval.operationId !== fields.operationId || approval.actorId !== fields.actorId || approval.name !== fields.name || approval.issuedAt !== fields.issuedAt)
        throw new Error('Approval identity changed');
    } catch { throw new AppError('INSTALLATION_BACKUP_UNAVAILABLE', 'Installation backup approval is unavailable', 503); }
    let operation;
    try { operation = await submitInstallationBackup(approval, socket); } catch (error) { backupError(error); }
    administrator(request, true);
    return reply.code(202).send({ok: true, operation});
  });

  app.get('/api/v1/installation-backups/:operationId', {config: {rateLimit: {max: 30, timeWindow: '1 minute'}}}, async request => {
    administrator(request);
    const {operationId} = z.strictObject({operationId: installationBackupId}).parse(request.params);
    z.strictObject({}).parse(request.query);
    const socket = endpoint();
    let operation;
    try { operation = await installationBackupStatus(operationId, socket); } catch (error) { backupError(error); }
    administrator(request);
    return {ok: true, operation};
  });

  app.post('/api/v1/installation-backups/:operationId/cancel',{bodyLimit:2048,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(request,reply)=>{
    const actor=administrator(request,true),{operationId}=z.strictObject({operationId:installationBackupId}).parse(request.params);
    const {name}=installationBackupInputSchema.pick({name:true}).parse(request.body);z.strictObject({}).parse(request.query);
    const socket=endpoint();let approval:InstallationBackupApproval;
    try{
      const fields={operationId,name,actorId:actor.id,issuedAt:(options.now??Date.now)()};
      approval=installationBackupApprovalSchema.parse(options.signCancellation?options.signCancellation(fields):signInstallationBackupCancellation(fields,options.approvalSecretPath!));
      if(approval.operationId!==fields.operationId||approval.actorId!==fields.actorId||approval.name!==fields.name||approval.issuedAt!==fields.issuedAt)throw new Error('Cancellation identity changed');
    }catch{throw new AppError('INSTALLATION_BACKUP_UNAVAILABLE','Installation backup approval is unavailable',503);}
    let operation;try{operation=await cancelInstallationBackup(approval,socket);}catch(error){backupError(error);}
    administrator(request,true);return reply.code(202).send({ok:true,operation});
  });
}

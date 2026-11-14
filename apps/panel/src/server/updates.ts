import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { updateStatus, submitUpdate, retryUpdate, prepareUpdate, applyUpdate, applyStatus, discoverUpdate, UpdaterClientError } from './updater-client.js';

const operationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const submission = z.strictObject({
  operationId,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  tag: z.string().max(64).regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/),
});

interface UpdateRoutesOptions {
  administrator: (request: FastifyRequest, mutation?: boolean) => unknown;
  socketPath?: string;
  applyEnabled?: boolean;
  currentVersion?: string;
}

function version(value: string): bigint[] | undefined {
  const match = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  return match ? match.slice(1).map(part => BigInt(part)) : undefined;
}
function newerRelease(tag: string, current: string): boolean {
  const target = version(tag), installed = version(current);
  if (!target || !installed) return false;
  for (let i = 0; i < 3; i++) {
    if (target[i]! !== installed[i]!) return target[i]! > installed[i]!;
  }
  return false;
}
function updateError(error: unknown): never {
  if (error instanceof UpdaterClientError && error.certainty === 'definitive') {
    if (error.code === 'not_found') throw new AppError('NOT_FOUND', 'Update operation not found', 404);
    if (['operation_in_progress', 'idempotency_conflict', 'recovery_required'].includes(error.code)) throw new AppError('UPDATE_CONFLICT', 'The update cannot proceed in its current state', 409);
    if (error.code === 'invalid_request' || error.code === 'invalid_input') throw new AppError('INVALID_UPDATE', 'The update request is invalid', 400);
  }
  throw new AppError('UPDATER_UNAVAILABLE', error instanceof UpdaterClientError && error.certainty === 'uncertain' ? 'The update outcome is unknown. Check its status before retrying.' : 'The update service is unavailable', 503);
}

export function registerUpdates(app: FastifyInstance, options: UpdateRoutesOptions) {
  const rateLimit = { max: 30, timeWindow: '1 minute' };
  const enabled = Boolean(options.applyEnabled && options.socketPath && version(options.currentVersion ?? ''));
  const socket = () => {
    if (!enabled || !options.socketPath) throw new AppError('UPDATE_UNAVAILABLE', 'Updates are not available on this installation', 503);
    return {socketPath: options.socketPath};
  };
  const verifyTarget = async (id: string, endpoint: {socketPath: string}) => {
    let operation;
    try { operation = await updateStatus(id, endpoint); } catch (error) { return updateError(error); }
    if (operation.status !== 'verified') throw new AppError('UPDATE_CONFLICT', 'The release has not been verified', 409);
    if (!newerRelease(operation.tag, options.currentVersion ?? '')) throw new AppError('INVALID_UPDATE', 'The release must be newer than this installation', 400);
  };
  app.get('/api/v1/updates', { config: { rateLimit } }, async request => {
    options.administrator(request);
    return { applyAvailable: enabled, verificationStatusConfigured: Boolean(options.socketPath) };
  });
  app.get('/api/v1/updates/discovery', { config: { rateLimit } }, async request => {
    options.administrator(request);
    const endpoint = socket(), current = `v${options.currentVersion!.replace(/^v/, '')}`;
    try {
      const discovery = await discoverUpdate(current, endpoint);
      if ((discovery.status === 'candidate' || discovery.status === 'release_pending') && !newerRelease(discovery.tag, current))
        throw new AppError('UPDATER_UNAVAILABLE', 'The release information is inconsistent', 503);
      return {discovery};
    } catch (error) { if (error instanceof AppError) throw error; updateError(error); }
  });
  app.get<{Params:{operationId:string}}>('/api/v1/updates/:operationId', { config: { rateLimit } }, async request => {
    options.administrator(request);
    const id = operationId.parse(request.params.operationId);
    if (!options.socketPath) throw new AppError('UPDATER_UNAVAILABLE', 'Update verification status is unavailable', 503);
    try { return { operation: await updateStatus(id, {socketPath: options.socketPath}) }; }
    catch (error) {
      if (error instanceof UpdaterClientError && error.code === 'not_found' && error.certainty === 'definitive') {
        throw new AppError('NOT_FOUND', 'Update operation not found', 404);
      }
      throw new AppError('UPDATER_UNAVAILABLE', 'Update verification status is unavailable', 503);
    }
  });
  app.post('/api/v1/updates', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    options.administrator(request, true);
    const input = submission.parse(request.body), endpoint = socket();
    if (!newerRelease(input.tag, options.currentVersion ?? '')) throw new AppError('INVALID_UPDATE', 'The release must be newer than this installation', 400);
    try { return {operation: await submitUpdate(input, endpoint)}; } catch (error) { updateError(error); }
  });
  app.post<{Params:{operationId:string}}>('/api/v1/updates/:operationId/retry', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    options.administrator(request, true);
    const id = operationId.parse(request.params.operationId);
    z.strictObject({}).parse(request.body);
    const endpoint = socket();
    try { return {operation: await retryUpdate(id, endpoint)}; } catch (error) { updateError(error); }
  });
  app.post<{Params:{operationId:string}}>('/api/v1/updates/:operationId/prepare', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    options.administrator(request, true);
    const id = operationId.parse(request.params.operationId); z.strictObject({}).parse(request.body);
    const endpoint = socket();
    await verifyTarget(id, endpoint);
    try { return {operation: await prepareUpdate(id, endpoint)}; } catch (error) { updateError(error); }
  });
  app.post<{Params:{operationId:string}}>('/api/v1/updates/:operationId/apply', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    options.administrator(request, true);
    const id = operationId.parse(request.params.operationId); z.strictObject({}).parse(request.body);
    const endpoint = socket();
    await verifyTarget(id, endpoint);
    try { return {operation: await applyUpdate(id, endpoint)}; } catch (error) { updateError(error); }
  });
  app.get<{Params:{operationId:string}}>('/api/v1/updates/:operationId/apply', { config: { rateLimit } }, async request => {
    options.administrator(request);
    const id = operationId.parse(request.params.operationId), endpoint = socket();
    try { return {operation: await applyStatus(id, endpoint)}; } catch (error) { updateError(error); }
  });
}

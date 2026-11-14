import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { updateStatus, UpdaterClientError } from './updater-client.js';

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
}

export function registerUpdates(app: FastifyInstance, options: UpdateRoutesOptions) {
  const rateLimit = { max: 30, timeWindow: '1 minute' };
  app.get('/api/v1/updates', { config: { rateLimit } }, async request => {
    options.administrator(request);
    return { applyAvailable: false, verificationStatusConfigured: Boolean(options.socketPath) };
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
    submission.parse(request.body);
    throw new AppError('UPDATE_UNAVAILABLE', 'Updates are not available on this installation', 503);
  });
  app.post<{Params:{operationId:string}}>('/api/v1/updates/:operationId/retry', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    options.administrator(request, true);
    operationId.parse(request.params.operationId);
    z.strictObject({}).parse(request.body);
    throw new AppError('UPDATE_UNAVAILABLE', 'Updates are not available on this installation', 503);
  });
}

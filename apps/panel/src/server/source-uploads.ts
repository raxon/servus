import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SourceUploadRecord } from '../shared/host-admin.js';
import type { User } from '../shared/types.js';
import { AppError } from './errors.js';
import type { Store } from './store.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const jsonUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dots, underscores and hyphens for the filename'),
  contentBase64: z.string().min(4).max(16 * 1024 * 1024),
}).strict();

function projectUploadDir(dataDir: string, projectId: string): string {
  return join(dataDir, 'source-uploads', projectId);
}

export function sourceUploadExists(dataDir: string, projectId: string, uploadId: string): SourceUploadRecord | null {
  if (!/^[a-f0-9-]{36}$/i.test(uploadId)) return null;
  const dir = projectUploadDir(dataDir, projectId);
  const archivePath = join(dir, `${uploadId}.tar.gz`);
  const metaPath = join(dir, `${uploadId}.json`);
  if (!existsSync(archivePath) || !existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as SourceUploadRecord;
  } catch {
    return null;
  }
}

export function registerSourceUploads(
  app: FastifyInstance,
  options: {
    dataDir: string;
    store: Store;
    session: (req: FastifyRequest, mutation?: boolean) => { user: User; csrfToken: string };
    projectAccess: (user: User, id: string, write?: boolean) => void;
  },
) {
  const { dataDir, store, session, projectAccess } = options;

  app.register(async (scoped) => {
    scoped.addContentTypeParser(
      ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );

    scoped.get<{ Params: { id: string } }>('/api/v1/projects/:id/source-uploads', async (req) => {
      const { user } = session(req);
      projectAccess(user, req.params.id, false);
      const dir = projectUploadDir(dataDir, req.params.id);
      if (!existsSync(dir)) return { uploads: [] };
      const uploads: SourceUploadRecord[] = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
          uploads.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as SourceUploadRecord);
        } catch { /* skip corrupt metadata */ }
      }
      uploads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { uploads: uploads.slice(0, 50) };
    });

    scoped.post<{ Params: { id: string } }>('/api/v1/projects/:id/source-uploads', async (req, reply) => {
      const { user } = session(req, true);
      projectAccess(user, req.params.id, true);

      let buffer: Buffer;
      let filename = 'source.tar.gz';

      if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
        const headerName = typeof req.headers['x-upload-filename'] === 'string' ? req.headers['x-upload-filename'].trim() : '';
        if (headerName && /^[A-Za-z0-9._-]{1,200}$/.test(headerName)) filename = headerName;
      } else {
        const parsed = jsonUploadSchema.parse(req.body);
        filename = parsed.filename;
        buffer = Buffer.from(parsed.contentBase64, 'base64');
      }

      if (buffer.length < 20 || buffer.length > MAX_UPLOAD_BYTES) {
        throw new AppError('INVALID_UPLOAD', 'Source archive must be between 20 bytes and 50 MiB', 400);
      }
      if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
        throw new AppError('INVALID_UPLOAD', 'Source upload must be a valid .tar.gz gzip archive', 400);
      }

      const id = randomUUID();
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const createdAt = new Date().toISOString();
      const dir = projectUploadDir(dataDir, req.params.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });

      const record: SourceUploadRecord = {
        id,
        projectId: req.params.id,
        filename,
        sizeBytes: buffer.length,
        sha256,
        createdAt,
      };
      writeFileSync(join(dir, `${id}.tar.gz`), buffer, { mode: 0o600 });
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
      store.recordAudit(user.id, 'project.source-upload.create', id);
      return reply.code(201).send(record);
    });

    scoped.delete<{ Params: { id: string; uploadId: string } }>('/api/v1/projects/:id/source-uploads/:uploadId', async (req) => {
      const { user } = session(req, true);
      projectAccess(user, req.params.id, true);
      const uploadId = z.string().uuid().parse(req.params.uploadId);
      const dir = projectUploadDir(dataDir, req.params.id);
      const archivePath = join(dir, `${uploadId}.tar.gz`);
      const metaPath = join(dir, `${uploadId}.json`);
      if (!existsSync(archivePath) && !existsSync(metaPath)) {
        throw new AppError('NOT_FOUND', 'Uploaded archive not found', 404);
      }
      rmSync(archivePath, { force: true });
      rmSync(metaPath, { force: true });
      store.recordAudit(user.id, 'project.source-upload.delete', uploadId);
      return { deleted: true };
    });
  });
}

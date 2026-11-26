import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_BRANDING, type PlatformBrandingSettings } from '../shared/platform-settings.js';
import type { User } from '../shared/types.js';
import type { Store } from './store.js';

const brandingUpdateSchema = z.object({
  brandName: z.string().trim().min(1).max(60).refine((v) => !/[<>&"'`\x00-\x1f]/.test(v), 'Invalid brand name'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex color like #2563eb'),
  logoUrl: z
    .string()
    .trim()
    .max(512)
    .refine((v) => /^https:\/\/[^\s<>"'`]+$/.test(v), 'Logo URL must be a valid https:// URL')
    .nullable()
    .optional(),
  defaultLocale: z.enum(['en', 'pl']).default('en'),
  maintenanceMode: z.boolean().default(false),
  maintenanceTitle: z.string().trim().min(1).max(120),
  maintenanceMessage: z.string().trim().min(1).max(1000),
  customErrorTitle: z.string().trim().min(1).max(120),
  customErrorMessage: z.string().trim().min(1).max(1000),
}).strict();

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function openExtrasDb(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, 'workspace-extras.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.exec(`CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  return db;
}

export function readPlatformBranding(dataDir: string | undefined): PlatformBrandingSettings {
  if (!dataDir) return { ...DEFAULT_BRANDING };
  const path = join(dataDir, 'workspace-extras.sqlite');
  if (!existsSync(path)) return { ...DEFAULT_BRANDING };
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instance_settings'").get();
    if (!exists) return { ...DEFAULT_BRANDING };
    const row = db.prepare("SELECT value_json, updated_at FROM instance_settings WHERE key='platform_branding'").get() as { value_json: string; updated_at: string } | undefined;
    if (!row) return { ...DEFAULT_BRANDING };
    const parsed = brandingUpdateSchema.safeParse(JSON.parse(row.value_json));
    if (!parsed.success) return { ...DEFAULT_BRANDING };
    return {
      ...DEFAULT_BRANDING,
      ...parsed.data,
      logoUrl: parsed.data.logoUrl ?? null,
      updatedAt: row.updated_at,
    };
  } catch {
    return { ...DEFAULT_BRANDING };
  } finally {
    db?.close();
  }
}

export function renderStatusHtml(branding: PlatformBrandingSettings, mode: 'maintenance' | 'error'): string {
  const title = mode === 'maintenance' ? branding.maintenanceTitle : branding.customErrorTitle;
  const message = mode === 'maintenance' ? branding.maintenanceMessage : branding.customErrorMessage;
  const code = mode === 'maintenance' ? '503' : '502';
  return `<!doctype html>
<html lang="${branding.defaultLocale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} - ${escapeHtml(branding.brandName)}</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b0f17; color: #e5e7eb; display: grid; place-items: center; min-height: 100vh; padding: 24px; }
    main { max-width: 520px; width: 100%; background: #131926; border: 1px solid #263147; border-radius: 14px; padding: 32px; box-shadow: 0 20px 50px rgba(0,0,0,0.45); }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: ${branding.accentColor}22; color: ${branding.accentColor}; border: 1px solid ${branding.accentColor}55; }
    h1 { margin: 16px 0 8px; font-size: 24px; color: #f9fafb; }
    p { margin: 0; line-height: 1.6; color: #9ca3af; }
    footer { margin-top: 24px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <main>
    <span class="badge">HTTP ${code}</span>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <footer>${escapeHtml(branding.brandName)}</footer>
  </main>
</body>
</html>`;
}

export function registerPlatformSettings(
  app: FastifyInstance,
  options: {
    dataDir: string;
    store: Store;
    administrator: (req: FastifyRequest, mutation?: boolean) => User;
  },
) {
  app.get('/api/v1/platform/branding', async () => readPlatformBranding(options.dataDir));

  app.put('/api/v1/settings/branding', async (req) => {
    const actor = options.administrator(req, true);
    const input = brandingUpdateSchema.parse(req.body ?? {});
    const now = new Date().toISOString();
    const db = openExtrasDb(options.dataDir);
    try {
      db.prepare(
        `INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('platform_branding', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      ).run(JSON.stringify(input), now);
    } finally {
      db.close();
    }
    options.store.recordAudit(actor.id, 'settings.branding.update', 'platform');
    return { ...input, logoUrl: input.logoUrl ?? null, updatedAt: now } satisfies PlatformBrandingSettings;
  });

  app.get<{ Querystring: { mode?: string } }>('/api/v1/platform/status-page', async (req, reply) => {
    const branding = readPlatformBranding(options.dataDir);
    const mode = req.query.mode === 'error' ? 'error' : 'maintenance';
    const status = mode === 'maintenance' ? 503 : 502;
    return reply.code(status).type('text/html; charset=utf-8').send(renderStatusHtml(branding, mode));
  });
}

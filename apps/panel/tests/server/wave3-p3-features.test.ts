import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';

const dirs: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const dir of dirs.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('Wave 3 (P3): Backup providers, Project export/import, WordPress & Box modules, Branding/i18n/Status pages', () => {
  it('supports SFTP, FTP/FTPS, Google Drive, and Dropbox backup storage profiles with redaction and SSRF protection', async () => {
    const dataDir = tempDir('panel-w3-bak-');
    const app = await createApp({ dataDir });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const headers = { cookie: setup.headers['set-cookie'] as string, 'x-csrf-token': (setup.json() as { csrfToken: string }).csrfToken };

    // Private IP for SFTP must be rejected
    const badSftp = await app.inject({
      method: 'POST',
      url: '/api/v1/backup-storage',
      headers,
      payload: { name: 'Private SFTP', destination: { type: 'sftp', host: '127.0.0.1', port: 22, username: 'bak', password: 'secret-password', path: 'backups' } },
    });
    expect(badSftp.statusCode).toBe(400);

    // Public IP SFTP succeeds and redacts password
    const sftp = await app.inject({
      method: 'POST',
      url: '/api/v1/backup-storage',
      headers,
      payload: { name: 'Hetzner StorageBox', destination: { type: 'sftp', host: '1.1.1.1', port: 23, username: 'u12345', password: 'sftp-secret-value-99', path: 'servus-bak' } },
    });
    expect(sftp.statusCode).toBe(201);
    expect(sftp.body).not.toContain('sftp-secret-value-99');
    expect((sftp.json() as { profile: { destination: { type: string; credentialsConfigured: boolean } } }).profile.destination).toMatchObject({ type: 'sftp', credentialsConfigured: true });

    // FTPS succeeds and redacts password
    const ftp = await app.inject({
      method: 'POST',
      url: '/api/v1/backup-storage',
      headers,
      payload: { name: 'FTPS Vault', destination: { type: 'ftp', host: '1.1.1.1', port: 21, username: 'ftpuser', password: 'ftp-secret-value-99', tls: true, path: 'bak' } },
    });
    expect(ftp.statusCode).toBe(201);
    expect(ftp.body).not.toContain('ftp-secret-value-99');

    // Google Drive succeeds and redacts token
    const gdrive = await app.inject({
      method: 'POST',
      url: '/api/v1/backup-storage',
      headers,
      payload: { name: 'Team Drive', destination: { type: 'gdrive', folderId: '1AbCdEfGhIjKlMnOpQr', accessToken: 'ya29.super-secret-gdrive-token' } },
    });
    expect(gdrive.statusCode).toBe(201);
    expect(gdrive.body).not.toContain('ya29.super-secret-gdrive-token');

    // Dropbox succeeds and redacts token
    const dropbox = await app.inject({
      method: 'POST',
      url: '/api/v1/backup-storage',
      headers,
      payload: { name: 'Dropbox Archive', destination: { type: 'dropbox', path: 'servus', accessToken: 'sl.super-secret-dropbox-token' } },
    });
    expect(dropbox.statusCode).toBe(201);
    expect(dropbox.body).not.toContain('sl.super-secret-dropbox-token');

    const listed = await app.inject({ method: 'GET', url: '/api/v1/backup-storage', headers });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { profiles: unknown[] }).profiles).toHaveLength(4);
  });

  it('exports and imports project bundles with services, Compose, shared env and scripts', async () => {
    const dataDir = tempDir('panel-w3-transfer-');
    const app = await createApp({ dataDir });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const headers = { cookie: setup.headers['set-cookie'] as string, 'x-csrf-token': (setup.json() as { csrfToken: string }).csrfToken };

    const src = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'source-proj', description: 'Migration source' } })).json() as { id: string };
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${src.id}/env`,
      headers,
      payload: { variables: [{ name: 'APP_ENV', value: 'prod', secret: false }, { name: 'API_KEY', value: 'secret-mig-value', secret: true }] },
    });
    const svcRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${src.id}/services`,
      headers: { ...headers, 'idempotency-key': 'mig-svc-1' },
      payload: { name: 'web', image: 'nginx:alpine', port: 80, hostname: 'src-web.localhost', environment: [{ name: 'SVC_SECRET', value: 'svc-top-secret', secret: true }] },
    });
    expect(svcRes.statusCode).toBe(202);
    const svcId = (svcRes.json() as { service: { id: string } }).service.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${src.id}/scripts`,
      headers,
      payload: { name: 'Check', description: 'Check app', command: 'echo ok', serviceId: svcId },
    });

    // Redacted export omits secrets
    const redacted = await app.inject({ method: 'GET', url: `/api/v1/projects/${src.id}/export`, headers });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.body).not.toContain('secret-mig-value');
    expect(redacted.body).not.toContain('svc-top-secret');

    // Full export includes secrets for admin migration
    const full = await app.inject({ method: 'GET', url: `/api/v1/projects/${src.id}/export?includeSecrets=true`, headers });
    expect(full.statusCode).toBe(200);
    expect(full.body).toContain('secret-mig-value');
    expect(full.body).toContain('svc-top-secret');

    // Import into a new project
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/import',
      headers,
      payload: { targetProjectName: 'migrated-proj', useAutomaticDomains: true, bundle: full.json() },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      projectName: 'migrated-proj',
      importedServices: ['web'],
      importedEnvCount: 2,
      importedScriptCount: 1,
    });
  });

  it('provisions dedicated WordPress (MariaDB + WP + script) and Box sandbox modules', async () => {
    const dataDir = tempDir('panel-w3-mod-');
    const app = await createApp({ dataDir });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const headers = { cookie: setup.headers['set-cookie'] as string, 'x-csrf-token': (setup.json() as { csrfToken: string }).csrfToken };
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'modules-proj' } })).json() as { id: string };

    const wp = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/modules/wordpress`,
      headers,
      payload: { name: 'blog', siteTitle: 'My Blog', phpMemoryLimit: '256M' },
    });
    expect(wp.statusCode).toBe(202);
    expect(wp.json()).toMatchObject({ databaseServiceName: 'blog-db', appServiceName: 'blog' });

    const box = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/modules/box`,
      headers,
      payload: { name: 'devbox', preset: 'node-22', memoryMb: 512 },
    });
    expect(box.statusCode).toBe(202);
    expect(box.json()).toMatchObject({ serviceName: 'devbox', preset: 'node-22' });

    const svcs = (await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/services`, headers })).json() as Array<{ name: string; kind: string }>;
    expect(svcs.map((s) => s.name).sort()).toEqual(['blog', 'blog-db', 'devbox']);
  });

  it('manages platform branding, locale, and renders branded maintenance and error pages', async () => {
    const dataDir = tempDir('panel-w3-brand-');
    const store = new Store(dataDir);
    const app = await createApp({ dataDir, store });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const headers = { cookie: setup.headers['set-cookie'] as string, 'x-csrf-token': (setup.json() as { csrfToken: string }).csrfToken };

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/branding',
      headers,
      payload: {
        brandName: 'Acme Cloud',
        accentColor: '#10b981',
        logoUrl: null,
        defaultLocale: 'pl',
        maintenanceMode: true,
        maintenanceTitle: 'Przerwa techniczna',
        maintenanceMessage: 'Wracamy za chwile.',
        customErrorTitle: 'Usluga niedostepna',
        customErrorMessage: 'Sprobuj ponownie.',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { brandName: string; defaultLocale: string }).brandName).toBe('Acme Cloud');

    // Public branding read (no auth needed for login screen)
    const pub = await app.inject({ method: 'GET', url: '/api/v1/platform/branding' });
    expect(pub.statusCode).toBe(200);
    expect((pub.json() as { defaultLocale: string }).defaultLocale).toBe('pl');

    const maintPage = await app.inject({ method: 'GET', url: '/api/v1/platform/status-page?mode=maintenance' });
    expect(maintPage.statusCode).toBe(503);
    expect(maintPage.body).toContain('Przerwa techniczna');
    expect(maintPage.body).toContain('Acme Cloud');

    const errPage = await app.inject({ method: 'GET', url: '/api/v1/platform/status-page?mode=error' });
    expect(errPage.statusCode).toBe(502);
    expect(errPage.body).toContain('Usluga niedostepna');
  });
});

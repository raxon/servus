import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';

it('serves rebuilt assets created after startup and preserves API errors and SPA navigation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panel-assets-'));
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<html><body>Panel workspace</body></html>');
  const app = await createApp({ dataDir: join(root, 'state'), webDir: web });
  try {
    await app.ready();
    writeFileSync(join(web, 'assets', 'new-build.js'), 'window.panelReady = true;');
    const asset = await app.inject('/assets/new-build.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('panelReady');
    const route = await app.inject({ url: '/projects/example', headers: { accept: 'text/html' } });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('Panel workspace');
    const api = await app.inject({ url: '/api/v1/missing', headers: { accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('NOT_FOUND');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

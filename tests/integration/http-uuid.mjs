import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const hostname = 'servus-http.test';
const server = await createServer({
  root: fileURLToPath(new URL('../../apps/panel', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, strictPort: false, allowedHosts: [hostname] },
  plugins: [{ name: 'http-uuid-fixture', configureServer(vite) {
    vite.middlewares.use('/http-uuid-fixture', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>HTTP UUID fixture</title>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  const base = `http://${hostname}:${server.httpServer.address().port}`;
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] });
  const page = await browser.newPage();
  const requests = [];
  await page.route(`${base}/api/v1/services/fixture/deploy`, async route => {
    const request = route.request();
    requests.push({ method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    await route.fulfill({ json: { id: 'fixture-action', status: 'queued' } });
  });
  await page.goto(`${base}/http-uuid-fixture`);
  assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues })),
    { secure: false, uuid: 'undefined', random: 'function' });
  const result = await page.evaluate(async () => {
    const { api, setCsrfToken } = await import('/src/web/api.ts');
    setCsrfToken('fixture-csrf');
    const first = await api('/services/fixture/deploy', { method: 'POST', body: {}, idempotent: true });
    await api('/services/fixture/deploy', { method: 'POST', body: {}, idempotent: true });
    return first;
  });
  assert.deepEqual(result, { id: 'fixture-action', status: 'queued' });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-csrf-token'], 'fixture-csrf');
    assert.match(request.headers['idempotency-key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(request.body, {});
  }
  assert.notEqual(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
  console.log('PASS deploy requests on an insecure HTTP origin retain cryptographic UUID v4 idempotency keys and CSRF headers. API responses mocked; no workload deployed.');
} finally {
  await browser?.close();
  await server.close();
}

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import pg from 'pg';
import { createClient } from 'redis';

const startedAt = Date.now();
const pool = process.env.PGHOST ? new pg.Pool({ host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE, connectionTimeoutMillis: 2000 }) : null;
const redis = process.env.REDIS_HOST ? createClient({ socket: { host: process.env.REDIS_HOST, reconnectStrategy: retries => Math.min(retries * 200, 2000), connectTimeout: 2000 }, password: process.env.REDIS_PASSWORD }) : null;
redis?.on('error', () => {});
if (redis) void redis.connect().catch(() => {});
await mkdir('/data', { recursive: true });

async function body(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 65536) throw new Error('Request too large'); }
  return text ? JSON.parse(text) : {};
}
http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    let output;
    if (path === '/health') {
      if (process.env.FAIL_HEALTH === '1' || Date.now() - startedAt < Number(process.env.HEALTH_DELAY_MS || 0)) { response.writeHead(503); response.end('unhealthy'); return; }
      if (pool) await pool.query('SELECT 1');
      if (redis && (!redis.isReady || await redis.ping() !== 'PONG')) throw new Error('Redis unavailable');
      output = { status: 'ok' };
    } else if (path === '/version' || path === '/') output = { version: process.env.FIXTURE_VERSION || 'v1', commit: process.env.SOURCE_COMMIT && process.env.SOURCE_COMMIT !== 'local' ? process.env.SOURCE_COMMIT : process.env.GIT_SHA || 'local', message: process.env.FIXTURE_MESSAGE || 'initial' };
    else if (path === '/record') {
      if (!pool) throw new Error('PostgreSQL is not configured');
      await pool.query('CREATE TABLE IF NOT EXISTS fixture_records (id text PRIMARY KEY, value text NOT NULL)');
      if (request.method === 'POST') {
        const input = await body(request);
        await pool.query('INSERT INTO fixture_records VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value', [String(input.id), String(input.value)]);
      }
      output = { records: (await pool.query('SELECT id,value FROM fixture_records ORDER BY id')).rows };
    } else if (path === '/counter') {
      if (!redis?.isReady) throw new Error('Redis is not ready');
      output = { counter: request.method === 'POST' ? await redis.incr('fixture-counter') : Number(await redis.get('fixture-counter') || 0) };
    } else if (path === '/file') {
      if (request.method === 'POST') await writeFile('/data/marker.txt', String((await body(request)).value));
      output = { value: await readFile('/data/marker.txt', 'utf8').catch(() => '') };
    } else if (path === '/log') {
      const marker = String((await body(request)).marker || 'fixture-marker').replaceAll('\n', '').slice(0, 100);
      console.log(`FIXTURE_LOG ${marker}`);
      output = { marker };
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(output));
  } catch {
    response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Dependency or fixture operation unavailable' }));
  }
}).listen(Number(process.env.PORT || 8080), '0.0.0.0');

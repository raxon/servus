import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.data/parity/git');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const work = join(directory, 'work');
const bare = join(directory, 'control.git');
const git = (args, cwd = work) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!existsSync(bare)) {
  mkdirSync(work, { recursive: true });
  git(['init', '-b', 'v1']);
  git(['config', 'user.name', 'Panel Fixture']); git(['config', 'user.email', 'fixture@localhost.test']);
  for (const file of ['Dockerfile', 'server.mjs', 'package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/fixtures/control', file), join(work, file));
  git(['add', '.']); git(['commit', '-m', 'Add deterministic application fixture']);
  git(['switch', '-c', 'v2']);
  writeFileSync(join(work, 'Dockerfile'), readFileSync(join(work, 'Dockerfile'), 'utf8').replace('FIXTURE_VERSION=v1', 'FIXTURE_VERSION=v2'));
  git(['add', '.']); git(['commit', '-m', 'Set application version v2']);
  git(['switch', '-c', 'broken']); copyFileSync(join(root, 'tests/fixtures/control/Dockerfile.broken'), join(work, 'Dockerfile'));
  git(['add', '.']); git(['commit', '-m', 'Add intentionally failing build']);
  git(['switch', 'v1']); git(['switch', '-c', 'unhealthy']);
  writeFileSync(join(work, 'Dockerfile'), readFileSync(join(work, 'Dockerfile'), 'utf8').replace('PORT=8080', 'PORT=8080 FAIL_HEALTH=1'));
  git(['add', '.']); git(['commit', '-m', 'Add intentionally unhealthy release']);
  git(['clone', '--bare', work, bare], directory);
  git(['update-server-info'], bare);
}
const commits = Object.fromEntries(['v1', 'v2', 'broken', 'unhealthy'].map(branch => [branch, git(['rev-parse', branch], bare)]));
if (!git(['branch', '--list', 'slow'], bare).trim()) {
  git(['switch', 'v2']); git(['switch', '-c', 'slow']);
  copyFileSync(join(root, 'tests/fixtures/control/server.mjs'), join(work, 'server.mjs'));
  writeFileSync(join(work, 'Dockerfile'), readFileSync(join(work, 'Dockerfile'), 'utf8').replace('--start-period=5s', '--start-period=30s'));
  git(['add', '.']); git(['commit', '-m', 'Add controlled readiness delay']);
  git(['push', bare, 'slow']); git(['update-server-info'], bare);
}
commits.slow = git(['rev-parse', 'slow'], bare);
writeFileSync(join(directory, 'commits.json'), JSON.stringify(commits, null, 2));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/control.git/') || pathname.includes('..')) { response.writeHead(404); response.end(); return; }
  const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathname, REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] || '', HTTP_GIT_PROTOCOL: request.headers['git-protocol'] || '', REMOTE_ADDR: '127.0.0.1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = Buffer.alloc(0); let headersSent = false;
  request.pipe(child.stdin);
  child.stdout.on('data', chunk => {
    if (headersSent) { response.write(chunk); return; }
    pending = Buffer.concat([pending, chunk]); const boundary = pending.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    const headers = {}; let status = 200;
    for (const line of pending.subarray(0, boundary).toString().split('\r\n')) {
      const colon = line.indexOf(':'); if (colon < 0) continue;
      const name = line.slice(0, colon).toLowerCase(); const value = line.slice(colon + 1).trim();
      if (name === 'status') status = Number(value.split(' ')[0]); else headers[name] = value;
    }
    headersSent = true; response.writeHead(status, headers); response.write(pending.subarray(boundary + 4));
  });
  child.on('close', () => { if (!headersSent) response.writeHead(500); response.end(); });
  child.on('error', () => { if (!headersSent) response.writeHead(500); response.end(); });
  request.on('error', () => child.kill());
});
server.listen(32180, '127.0.0.1', () => console.log('Fixture Git: http://127.0.0.1:32180/control.git'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));

import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or later. Run nvm use first.');
const dataDir = resolve(process.env.PANEL_DATA_DIR || '.data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let dockerSocket = process.env.PANEL_DOCKER_SOCKET;
if (!dockerSocket) {
  try {
    dockerSocket = execFileSync('docker', ['context', 'inspect', 'colima-panel-dev', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace('unix://', '');
  } catch { dockerSocket = '/var/run/docker.sock'; }
}
let dockerConfig = process.env.DOCKER_CONFIG;
if (!dockerConfig && existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-buildx')) {
  dockerConfig = resolve(dataDir, 'docker-config');
  mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(dockerConfig, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: ['/opt/homebrew/lib/docker/cli-plugins'] }), { mode: 0o600 });
}
const env = { ...process.env, ...(dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {}), PANEL_DATA_DIR: dataDir, PANEL_DOCKER_SOCKET: dockerSocket };
const children = [];
const restarts = new Map();
const timers = new Set();
let stopping = false;
function recordProcesses() {
  writeFileSync(resolve(dataDir, 'local-processes.json'), JSON.stringify({ supervisor: process.pid, children: children.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid), components: Object.fromEntries(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => [child.component, child.pid])) }), { mode: 0o600 });
}
function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000).unref();
}
function launch(component) {
  const child = spawn(process.execPath, [`dist/${component}/index.js`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.component = component;
  children.push(child);
  child.stdout.on('data', chunk => process.stdout.write(`[${component}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${component}] ${chunk}`));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  child.on('exit', code => {
    if (stopping) return;
    const history = (restarts.get(component) || []).filter(time => Date.now() - time < 60000);
    history.push(Date.now()); restarts.set(component, history);
    if (history.length > 5) { console.error(`${component} repeatedly exited. Stopping the local supervisor.`); process.exitCode = code || 1; stop(); return; }
    console.error(`${component} exited. Restarting it with persistent state.`);
    const timer = setTimeout(() => { timers.delete(timer); if (!stopping) launch(component); }, 1000);
    timers.add(timer);
    recordProcesses();
  });
  recordProcesses();
}
for (const component of ['agent', 'server', 'worker']) launch(component);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Panel: http://localhost:4180');
console.log(`First setup token: ${resolve(dataDir, 'bootstrap-token')} (shown only in this local file).`);

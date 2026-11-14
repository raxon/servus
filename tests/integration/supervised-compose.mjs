#!/usr/bin/env node
// Validate the actual release Compose template with the host policy validator.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..'), dir = mkdtempSync(join(tmpdir(), 'servus-supervised-compose-'));
const image = `ghcr.io/raxon/servus@sha256:${'a'.repeat(64)}`, data = '/var/lib/servus', gate = '/etc/servus/lifecycle';
const control = '/run/servus-supervisor', secrets = '/etc/servus/supervisor-secrets', updater = '/run/servus-updater/control';
try {
  const values = { SERVUS_IMAGE:image, SERVUS_DATA_DIR:data, SERVUS_LIFECYCLE_DIR:gate, SERVUS_SUPERVISOR_CONTROL_DIR:control,
    SERVUS_SUPERVISOR_SECRET_DIR:secrets, SERVUS_UPDATER_SOCKET_DIR:updater, SERVUS_DOCKER_GID:'998', SERVUS_ALLOWED_ORIGINS:'https://example.test' };
  const envFile=join(dir,'servus.env'), imageEnv=join(dir,'image.json'), canonical=join(dir,'canonical.json');
  writeFileSync(envFile, Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join(''), {mode:0o600});
  writeFileSync(imageEnv, JSON.stringify(['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=24.1.0','YARN_VERSION=1.22.0','NODE_ENV=production','PANEL_DATA_DIR=/var/lib/panel','PANEL_HOST=0.0.0.0','PANEL_PORT=4180']));
  const dockerEnv = { PATH:process.env.PATH, HOME:process.env.HOME, ...(process.env.DOCKER_CONTEXT ? {DOCKER_CONTEXT:process.env.DOCKER_CONTEXT} : {}) };
  const raw=execFileSync('docker',['compose','--env-file',envFile,'-f',join(root,'deployment/compose-supervised.yaml'),'-p','servus','config','--format','json'], {encoding:'utf8',env:dockerEnv});
  const document=JSON.parse(raw);
  const validate = (value, output) => spawnSync('python3',['-I',join(root,'apps/updater/validate-compose.py'),gate,image,data,envFile,imageEnv,control,secrets,output],{input:JSON.stringify(value),encoding:'utf8'});
  const result=validate(document,canonical);
  if (result.status !== 0) {
    const trace = `import runpy,sys\np=sys.argv[1];sys.argv=sys.argv[1:]\ndef observe(frame,event,arg):\n if event=='exception' and frame.f_code.co_filename==p and arg[0] is ValueError: print('validator rejected line',frame.f_lineno,file=sys.stderr)\n return observe\nsys.settrace(observe);runpy.run_path(p,run_name='__main__')`;
    const detail=spawnSync('python3',['-I','-c',trace,join(root,'apps/updater/validate-compose.py'),gate,image,data,envFile,imageEnv,control,secrets,join(dir,'diagnostic.json')],{input:JSON.stringify(document),encoding:'utf8'});
    console.error(execFileSync('docker',['compose','version'],{encoding:'utf8',env:dockerEnv}).trim(),detail.stderr,JSON.stringify(document));
  }
  assert.equal(result.status,0,result.stderr);
  const checked=JSON.parse(readFileSync(canonical,'utf8'));
  for (const role of ['api','worker','agent']) {
    const mounts=checked.services[role].volumes.filter(item=>item.target==='/run/servus-updater');
    if (role === 'api') { assert.equal(mounts.length,1);assert.equal(mounts[0].source,updater);assert.equal(mounts[0].read_only,true); }
    else assert.equal(mounts.length,0);
  }
  const altered=structuredClone(document);
  altered.services.api.volumes.find(item=>item.target==='/run/servus-updater').read_only=false;
  assert.notEqual(validate(altered,join(dir,'rejected.json')).status,0);
  console.log('Supervised Compose: updater mount and policy validation passed');
} finally { rmSync(dir,{recursive:true,force:true}); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = process.env.SERVUS_INSTALLER_PATH || fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));
function runFixture(supervised = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'servus-signed-route-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const command = (name, body) => writeFileSync(join(bin,name),`#!/bin/bash\n${body}\n`,{mode:0o755});
    command('uname','if [[ $1 == -s ]]; then echo Linux; else echo x86_64; fi');
    command('id','echo 0'); command('ss','exit 0'); command('flock','exit 0');
    command('ip',"printf '2: eth0 inet 192.0.2.10/24 scope global eth0\\n'");
    command('stat','echo 999'); command('curl','exit 0');
    command('docker',`case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; swarm) exit 0;; build) echo legacy-build > "$FIXTURE_ROOT/build"; exit 42;; *) exit 0;; esac`);
    const os = join(root,'os-release'); writeFileSync(os,'ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n');
    const install=join(root,'install');
    if (supervised) { mkdirSync(install); writeFileSync(join(install,'.servus-install'),'servus-installer-v1\n'); writeFileSync(join(install,'.lifecycle-enabled-v1'),'servus-lifecycle-v1\n'); }
    const commandScript = `source "$1"; open_installer_tty() { return 1; }; install_dependencies() { :; }; prepare_docker_client() { :; }; trusted_docker() { docker "$@"; }; check_port() { :; };
extract_source() { mkdir -p "$2/apps/panel" "$2/deployment" "$2/scripts"; printf x > "$2/apps/panel/package.json"; printf x > "$2/deployment/compose.yaml"; printf x > "$2/deployment/compose-supervised.yaml"; printf x > "$2/Dockerfile"; printf 'bootstrap_signed_install() { echo signed-route; }\\n' > "$2/scripts/signed-bootstrap.sh"; };
main`;
    const result=spawnSync('bash',['-c',commandScript,'test',installer],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,SERVUS_INSTALLER_LIBRARY:'1',SERVUS_OS_RELEASE:os,SERVUS_INSTALL_DIR:install,SERVUS_CONFIG_DIR:join(root,'config'),SERVUS_DATA_DIR:join(root,'data'),SERVUS_REF:'main',SERVUS_BIND_ADDRESS:'127.0.0.1',SERVUS_PUBLIC_URL:'http://localhost:4180',FIXTURE_ROOT:root}});
    return {result,built: (()=>{try{return readFileSync(join(root,'build'),'utf8')}catch{return ''}})()};
  } finally { rmSync(root,{recursive:true,force:true}); }
}
test('default installation enters signed bootstrap before building any image',()=>{
  const {result,built}=runFixture(); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/signed-route/); assert.equal(built,'');
});
test('existing supervised installations reject the legacy installer path',()=>{
  const {result,built}=runFixture(true); assert.notEqual(result.status,0); assert.match(result.stderr,/supervised installation must be managed/); assert.equal(built,'');
});

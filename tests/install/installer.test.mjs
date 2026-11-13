import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));
const directories = [];
process.on('exit', () => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'servus-installer-'));
  directories.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const command = (name, text) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${text}\n`, { mode: 0o755 });
  command('uname', 'if [[ $1 == -s ]]; then echo Linux; else echo aarch64; fi');
  command('id', 'echo 0'); command('hostname', 'echo 192.0.2.10'); command('ss', 'exit 0');
  command('flock', 'exit 0'); command('stat', 'echo 0');
  command('docker', 'case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; swarm) exit 0;; build) echo "intentional build failure" >&2; exit 42;; *) exit 0;; esac');
  const release = join(root, 'os-release');
  writeFileSync(release, 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n');
  const source = join(root, 'checkout');
  mkdirSync(join(source, 'apps/panel'), { recursive: true });mkdirSync(join(source, 'deployment'));
  writeFileSync(join(source, 'Dockerfile'), 'FROM scratch\n');writeFileSync(join(source, 'apps/panel/package.json'), '{}');writeFileSync(join(source, 'deployment/compose.yaml'), 'services: {}');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SERVUS_INSTALLER_LIBRARY: '1', SERVUS_OS_RELEASE: release,
    SERVUS_INSTALL_DIR: join(root, 'install'), SERVUS_CONFIG_DIR: join(root, 'config'), SERVUS_DATA_DIR: join(root, 'data') };
  return { root, bin, command, release, source, env };
}
function run(f, args, script = 'source "$1"; shift; "$@"') {
  return spawnSync('bash', ['-c', script, 'servus-tests', installer, ...args], { env: f.env, encoding: 'utf8' });
}
function succeeds(result) { assert.equal(result.status, 0, result.stderr); }
function fails(result, pattern) { assert.notEqual(result.status, 0, result.stdout);assert.match(result.stderr, pattern); }

test('help works without touching installation directories', () => {
  const f=fixture();const r=run(f,['main','--help']);succeeds(r);assert.match(r.stdout,/--dry-run/);assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('dry run validates a supported arm64 checkout without mutating the host', () => {
  const f=fixture();const r=run(f,['main','--dry-run','--source',f.source,'--port','4280','--ingress-port','28080']);succeeds(r);assert.match(r.stdout,/ubuntu 24.04 \(arm64\)/);assert.match(r.stdout,/Panel port: 4280/);assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('dry run rejects unsupported operating systems', () => {
  const f=fixture();f.command('uname','echo Darwin');fails(run(f,['main','--dry-run']),/requires Linux/);
});
test('dry run rejects unsupported distribution versions', () => {
  const f=fixture();writeFileSync(f.release,'ID=ubuntu\nVERSION_ID=20.04\nVERSION_CODENAME=focal\n');fails(run(f,['main','--dry-run']),/Unsupported distribution/);
});
test('unsupported architecture is refused', () => {
  const f=fixture();f.command('uname','if [[ $1 == -s ]]; then echo Linux; else echo riscv64; fi');fails(run(f,['main','--dry-run']),/amd64 or arm64/);
});
test('release metadata is parsed as data rather than shell code', () => {
  const f=fixture();const sentinel=join(f.root,'executed');writeFileSync(f.release,`ID=ubuntu\nVERSION_ID="$(touch ${sentinel})"\nVERSION_CODENAME=noble\n`);fails(run(f,['main','--dry-run']),/Unsupported distribution/);assert.equal(existsSync(sentinel),false);
});
test('ports reject overflow, zero, command text and equal normalized values', () => {
  const f=fixture();for(const value of ['0','65536','-2','80;touch','1e3'])fails(run(f,['main','--dry-run','--port',value]),/Invalid port/);
  fails(run(f,['main','--dry-run','--port','00080','--ingress-port','80']),/different ports/);
});
test('refs and hostnames reject shell metacharacters and traversal', () => {
  const f=fixture();for(const value of ['../../etc','main;echo bad','-main','feature//one'])fails(run(f,['main','--dry-run','--ref',value]),/Invalid source ref/);
  fails(run(f,['main','--dry-run','--hostname','example.test;echo']),/Invalid hostname/);
  for(const value of ['-label.example','label-.example','a..b','999.1.1.1','01.2.3.4'])fails(run(f,['main','--dry-run','--hostname',value]),/Invalid/);
});
test('public origins normalize case and browser default ports', () => {
  const f=fixture();for(const [input,output] of [['https://Panel.Example:00443','https://panel.example'],['http://Panel.Example:00080','http://panel.example'],['http://Panel.Example:04180','http://panel.example:4180']]){
    const result=run(f,['normalize_origin',input]);succeeds(result);assert.equal(result.stdout,output);
  }
});
test('public origin accepts only an HTTP(S) origin and valid port', () => {
  const f=fixture();for(const value of ['https://panel.example/path','https://panel.example:65536','http://a..b','javascript:alert(1)']){f.env.SERVUS_PUBLIC_URL=value;fails(run(f,['main','--dry-run']),/Invalid|must be/);}
  f.env.SERVUS_PUBLIC_URL='https://panel.example';succeeds(run(f,['main','--dry-run']));
});
test('unknown options and missing values fail before any install', () => {
  const f=fixture();fails(run(f,['main','--oops']),/Unknown option/);fails(run(f,['main','--port']),/Missing value/);assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('installer refuses nested data/config/install paths', () => {
  const f=fixture();f.env.SERVUS_DATA_DIR=join(f.env.SERVUS_INSTALL_DIR,'data');fails(run(f,['main','--dry-run']),/must not overlap/);
});
test('an unprivileged real install is rejected', () => {
  const f=fixture();f.command('id','echo 501');fails(run(f,['main','--source',f.source]),/as root/);assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('installer refuses symlink ancestors and keeps their targets untouched', () => {
  const f=fixture();const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.root,'alias'));f.env.SERVUS_DATA_DIR=join(f.root,'alias','data');fails(run(f,['main','--source',f.source]),/Symlink in installation path/);assert.deepEqual(readdirSync(outside),[]);
});
test('installer refuses unowned nonempty configuration', () => {
  const f=fixture();mkdirSync(f.env.SERVUS_CONFIG_DIR);writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'keep'),'existing');fails(run(f,['main','--source',f.source]),/Configuration directory is not empty/);assert.equal(readFileSync(join(f.env.SERVUS_CONFIG_DIR,'keep'),'utf8'),'existing');
});
test('installer refuses a symlinked environment file', () => {
  const f=fixture();mkdirSync(f.env.SERVUS_CONFIG_DIR);const keep=join(f.root,'keep');writeFileSync(keep,'unchanged');symlinkSync(keep,join(f.env.SERVUS_CONFIG_DIR,'servus.env'));fails(run(f,['main','--source',f.source]),/must not be symlinks/);assert.equal(readFileSync(keep,'utf8'),'unchanged');
});
test('a current release pointing outside owned releases is rejected', () => {
  const f=fixture();mkdirSync(f.env.SERVUS_INSTALL_DIR);writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');mkdirSync(join(f.root,'outside/deployment'),{recursive:true});writeFileSync(join(f.root,'outside/deployment/compose.yaml'),'services: {}');symlinkSync(join(f.root,'outside'),join(f.env.SERVUS_INSTALL_DIR,'current'));
  fails(run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"'),/outside owned releases/);
});
test('an occupied port is not adopted from another application', () => {
  const f=fixture();f.command('ss','echo LISTEN');fails(run(f,['check_port','4180','api'],'source "$1"; shift; install_dir="$SERVUS_INSTALL_DIR"; "$@"'),/port 4180 is occupied/);
});
test('an owned existing API container is accepted on rerun', () => {
  const f=fixture();mkdirSync(f.env.SERVUS_INSTALL_DIR);writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');f.command('ss','echo LISTEN');f.command('docker','echo owned-container');succeeds(run(f,['check_port','4180','api'],'source "$1"; shift; install_dir="$SERVUS_INSTALL_DIR"; "$@"'));
});
test('another panel ingress blocks first installation even on a different port', () => {
  const f=fixture();f.command('docker','if [[ $1 == service ]]; then echo self-hosted-panel; fi');fails(run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"'),/panel ingress service already exists/);
});
test('a held installer lock stops before dependency installation', () => {
  const f=fixture();f.command('flock','exit 1');fails(run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { touch "$SERVUS_DATA_DIR"; }; main "$@"'),/Another Servus installation/);assert.equal(existsSync(f.env.SERVUS_DATA_DIR),false);
});
test('failed first build cleans staging and leaves a reusable owned install', () => {
  const f=fixture();const r=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"');fails(r,/intentional build failure/);assert.equal(readFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'utf8'),'servus-installer-v1\n');assert.equal(existsSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env')),false);assert.equal(existsSync(f.env.SERVUS_DATA_DIR),false);assert.deepEqual(readdirSync(f.env.SERVUS_INSTALL_DIR).filter(n=>n.startsWith('.staging.')),[]);
});
test('Swarm initialization does not print join credentials into install output', () => {
  const f=fixture();f.command('docker','case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; swarm) echo "sensitive-join-token"; exit 0;; build) echo "intentional build failure" >&2; exit 42;; *) exit 0;; esac');
  const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"');fails(result,/intentional build failure/);assert.doesNotMatch(result.stdout,/sensitive-join-token/);assert.doesNotMatch(result.stderr,/sensitive-join-token/);
});
test('failed update build preserves previous environment and database bytes', () => {
  const f=fixture();for(const p of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(p);
  writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
  const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://192.0.2.10:4180\nSERVUS_BIND_ADDRESS=0.0.0.0\nSERVUS_IMAGE=previous-image\n`;
  writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);writeFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'database-must-survive');
  fails(run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"'),/intentional build failure/);
  assert.equal(readFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),'utf8'),env);assert.equal(readFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'utf8'),'database-must-survive');assert.deepEqual(readdirSync(f.env.SERVUS_INSTALL_DIR).filter(n=>n.startsWith('.staging.')),[]);
});
test('Compose startup failure restores the previous environment and containers', () => {
  const f=fixture();for(const p of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(p);
  writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');const previous=join(f.env.SERVUS_INSTALL_DIR,'releases/previous');mkdirSync(join(previous,'deployment'),{recursive:true});writeFileSync(join(previous,'deployment/compose.yaml'),'services: {}');symlinkSync(previous,join(f.env.SERVUS_INSTALL_DIR,'current'));
  const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://192.0.2.10:4180\nSERVUS_BIND_ADDRESS=0.0.0.0\nSERVUS_IMAGE=previous-image\n`;
  writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);writeFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'database-must-survive');f.env.SERVUS_TEST_ROOT=f.root;
  f.command('stat','if [[ $2 == %u ]]; then echo 1000; else echo 0; fi');
  f.command('docker',`case "$1" in
service) exit 1;; ps) exit 0;; info) echo inactive;; swarm|build) exit 0;;
compose) if [[ " $* " == *" up "* ]]; then
 if [[ ! -f $SERVUS_TEST_ROOT/up-called ]]; then touch "$SERVUS_TEST_ROOT/up-called"; echo 'intentional startup failure' >&2; exit 17; fi
 touch "$SERVUS_TEST_ROOT/rollback-started"
 fi; exit 0;;
*) exit 0;; esac`);
  const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"');fails(result,/Previous containers restored/);assert.match(result.stderr,/intentional startup failure/);
  assert.ok(existsSync(join(f.root,'rollback-started')));assert.equal(readFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),'utf8'),env);assert.equal(readFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'utf8'),'database-must-survive');assert.deepEqual(readdirSync(f.env.SERVUS_INSTALL_DIR).filter(n=>n.startsWith('.staging.')),[]);
});

function archive(f, entries) {
  const output=join(f.root,'source.tar');const result=spawnSync('python3',['-c',`import io,json,sys,tarfile
with tarfile.open(sys.argv[1],'w') as out:
 for item in json.load(sys.stdin):
  member=tarfile.TarInfo(item['name'])
  if item.get('link'):
   member.type=tarfile.SYMTYPE;member.linkname=item['link'];out.addfile(member)
  else:
   data=item.get('data','data').encode();member.size=len(data);out.addfile(member,io.BytesIO(data))
`,output],{input:JSON.stringify(entries),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return output;
}
test('safe source extraction strips one root and preserves file bytes', () => {
  const f=fixture(),tar=archive(f,[{name:'source/apps/panel/package.json',data:'{"ok":true}'}]),out=join(f.root,'unpacked');succeeds(run(f,['extract_source',tar,out]));assert.equal(readFileSync(join(out,'apps/panel/package.json'),'utf8'),'{"ok":true}');
});
test('source extraction rejects traversal, absolute names, links and multiple roots', () => {
  for(const entries of [[{name:'source/../../escape'}],[{name:'/etc/escape'}],[{name:'source/alias',link:'/etc'}],[{name:'one/file'},{name:'two/file'}]]) {
    const f=fixture(),tar=archive(f,entries);fails(run(f,['extract_source',tar,join(f.root,'unpacked')]),/Unsafe|link or special|one root/);assert.equal(existsSync(join(f.root,'escape')),false);
  }
});

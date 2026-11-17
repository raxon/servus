import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

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
  writeFileSync(join(source, 'Dockerfile'), 'FROM scratch\n');writeFileSync(join(source, 'apps/panel/package.json'), '{}');writeFileSync(join(source, 'deployment/compose.yaml'), '# fixture\nservices: {}');writeFileSync(join(source, 'deployment/compose-supervised.yaml'), '# /run/servus-lifecycle\nservices: {}');writeFileSync(join(source, 'deployment/lifecycle-gate.sh'), '# fixture\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SERVUS_INSTALLER_LIBRARY: '1', SERVUS_OS_RELEASE: release,
    SERVUS_INSTALL_DIR: join(root, 'install'), SERVUS_CONFIG_DIR: join(root, 'config'), SERVUS_DATA_DIR: join(root, 'data') };
  return { root, bin, command, release, source, env };
}
function run(f, args, script = 'source "$1"; shift; "$@"') {
  // Unit fixtures mock Docker and privileged host checks; integration tests run the real checks separately.
  script = script.replace('source "$1";', 'source "$1"; open_installer_tty() { return 1; }; trusted_docker() { docker "$@"; }; prepare_docker_client() { :; }; prepare_runtime() { :; }; require_supervisor_socket() { :; }; verify_lifecycle_image() { :; }; verify_lifecycle_compose() { printf "{\\\"fixture\\\":true}\\n" > "$9"; };');
  return spawnSync('bash', ['-c', script, 'servus-tests', installer, ...args], { env: f.env, encoding: 'utf8' });
}
function succeeds(result) { assert.equal(result.status, 0, result.stderr); }
function fails(result, pattern) { assert.notEqual(result.status, 0, result.stdout);assert.match(result.stderr, pattern); }

function writeTestDatabase(path, version = 2) {
  const result = spawnSync('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("PRAGMA user_version="+sys.argv[2]); db.commit(); db.close()', path, String(version)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
test('success instructions cover first setup and reruns without exposing a token', () => {
  const f=fixture();
  const result=run(f,['print_success','https://panel.example.test', '/etc/servus/servus.env', '/opt/servus', '127.0.0.1', '4180']);
  succeeds(result);
  assert.match(result.stdout,/Configured panel origin: https:\/\/panel\.example\.test/);
  assert.match(result.stdout,/Management listener: 127\.0\.0\.1:4180/);
  assert.doesNotMatch(result.stdout,/is listening at https/);
  assert.match(result.stdout,/choose Create administrator/);
  assert.match(result.stdout,/at least 8 characters/);
  assert.match(result.stdout,/logs --tail=100/);
  assert.doesNotMatch(result.stdout,/ssh -N/,'An HTTPS origin uses its configured proxy');
  assert.doesNotMatch(result.stdout,/bootstrap|setup token/i);
});
test('loopback setup prints the exact tunnel, browser URL and service commands', () => {
  const f=fixture();const result=run(f,['print_success','http://localhost:4280','/etc/servus/servus.env','/opt/servus','127.0.0.1','4280','165.227.165.232']);
  succeeds(result);assert.match(result.stdout,/ssh -N -L 127\.0\.0\.1:4280:127\.0\.0\.1:4280 root@165\.227\.165\.232/);
  assert.match(result.stdout,/Then open: http:\/\/127\.0\.0\.1:4280/);
  assert.match(result.stdout,/systemctl status servus-supervisor\.service servus-updater\.service/);
});
test('interactive flags remain deterministic in automation and dry runs', () => {
  const f=fixture();
  succeeds(run(f,['main','--dry-run','--interactive']));
  succeeds(run(f,['main','--dry-run','--non-interactive']));
  succeeds(run(f,['main','--dry-run','--yes']));
  fails(run(f,['main','--interactive','--non-interactive']),/cannot be combined/);
  fails(run(f,['main','--interactive']),/requires a terminal/);
  assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('host IPv4 discovery excludes Docker bridges, loopback, duplicates and link-local addresses', () => {
  const f=fixture();f.command('ip',`cat <<'IPS'
1: lo inet 127.0.0.1/8 scope global lo
2: eth0 inet 165.227.165.232/20 scope global eth0
2: eth0 inet 10.19.0.5/16 scope global eth0
2: eth0 inet 10.19.0.5/16 scope global eth0
3: docker0 inet 172.17.0.1/16 scope global docker0
4: br-fixture inet 172.18.0.1/16 scope global br-fixture
5: eth1 inet 169.254.1.1/16 scope global eth1
IPS`);
  const result=run(f,['host_ipv4_addresses']);succeeds(result);
  assert.deepEqual(result.stdout.trim().split('\n'),['165.227.165.232','10.19.0.5']);
});
test('ambiguous non-interactive networks fail with the actionable flag before Swarm changes', () => {
  const f=fixture();f.command('ip',"printf '2: eth0 inet 165.227.165.232/20 scope global eth0\\n2: eth0 inet 10.19.0.5/16 scope global eth0\\n'");
  const result=run(f,[],'source "$1"; swarm_advertise_addr=; select_swarm_address');
  fails(result,/Multiple host IPv4 addresses/);assert.match(result.stderr,/--swarm-advertise-addr 165\.227\.165\.232/);
});
test('a single host IPv4 is selected automatically', () => {
  const f=fixture();f.command('ip',"printf '2: eth0 inet 165.227.165.232/20 scope global eth0\\n'");
  const result=run(f,[],'source "$1"; swarm_advertise_addr=; select_swarm_address; printf "SELECTED=%s" "$swarm_advertise_addr"');
  succeeds(result);assert.match(result.stdout,/SELECTED=165\.227\.165\.232/);
});

function terminalFixture(f, mode) {
  const program=String.raw`import errno,os,pty,select,signal,sys,time
mode=sys.argv[2]
if mode in ('wizard','eof'):
    script='source "$1"; test ! -t 0; port=4180; ingress_port=80; open_installer_tty; installer_wizard; printf "CHOSEN=%s,%s\\n" "$port" "$ingress_port"; close_installer_tty'
    answers=[(b'Choose [1-4',b'2\n'),(b'Management panel port',b'4280\n'),(b'Application HTTP port',b'28080\n')]
    if mode=='eof':answers=[(b'Choose [1-4',b'\x04')]
else:
    script='source "$1"; test ! -t 0; swarm_advertise_addr=; open_installer_tty; select_swarm_address; printf "CHOSEN_IP=%s\\n" "$swarm_advertise_addr"; close_installer_tty'
    answers=[(b'Address number:',b'2\n')]
pid,fd=pty.fork()
if pid==0:
    null=os.open('/dev/null',os.O_RDONLY);os.dup2(null,0);os.close(null)
    os.execvp('bash',['bash','-c',script,'fixture',sys.argv[1]])
output=b'';deadline=time.monotonic()+10
while time.monotonic()<deadline:
    ready,_,_=select.select([fd],[],[],0.1)
    if ready:
        try:chunk=os.read(fd,65536)
        except OSError as error:
            if error.errno==errno.EIO:break
            raise
        if not chunk:break
        output+=chunk
        if answers and answers[0][0] in output:
            os.write(fd,answers.pop(0)[1])
    done,status=os.waitpid(pid,os.WNOHANG)
    if done:break
else:
    os.kill(pid,signal.SIGKILL);os.waitpid(pid,0);raise RuntimeError('Terminal fixture timed out')
os.close(fd)
try:_,status=os.waitpid(pid,0)
except ChildProcessError:pass
sys.stdout.buffer.write(output)
raise SystemExit(os.waitstatus_to_exitcode(status))`;
  return spawnSync('python3',['-c',program,installer,mode],{env:f.env,encoding:'utf8',timeout:15000});
}
test('guided ports read the controlling terminal when stdin belongs to a script pipe', () => {
  const result=terminalFixture(fixture(),'wizard');succeeds(result);
  assert.match(result.stdout,/CHOSEN=4280,28080/);
});
test('the address picker reads the chosen interface from the controlling terminal', () => {
  const f=fixture();f.command('ip',"printf '2: eth0 inet 165.227.165.232/20 scope global eth0\\n2: eth0 inet 10.19.0.5/16 scope global eth0\\n'");
  const result=terminalFixture(f,'address');succeeds(result);assert.match(result.stdout,/CHOSEN_IP=10\.19\.0\.5/);
});
test('closing terminal input cancels the wizard instead of accepting defaults', () => {
  const result=terminalFixture(fixture(),'eof');assert.notEqual(result.status,0);
  assert.match(result.stdout,/Terminal input closed/);
  assert.doesNotMatch(result.stdout,/CHOSEN=/);
});
test('help works without touching installation directories', () => {
  const f=fixture();const r=run(f,['main','--help']);succeeds(r);assert.match(r.stdout,/--dry-run/);assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('exact signed releases reject ambiguous source selection before host changes', () => {
  const f=fixture();delete f.env.SERVUS_REF;
  const planned=run(f,['main','--dry-run','--release','v0.1.52']);succeeds(planned);
  assert.match(planned.stdout,/Signed release: v0\.1\.52/);
  for(const tag of ['', '0.1.52','v00.1.52','v0.1.52-beta','v0.1.52;echo','v'+'1'.repeat(64)+'.1.1'])
    fails(run(f,['main','--dry-run','--release',tag]),/Invalid signed release tag/);
  fails(run(f,['main','--release']),/Missing value/);
  fails(run(f,['main','--release','v0.1.52','--release','v0.1.53']),/specified once/);
  for(const extra of [['--source',f.source],['--image',`ghcr.io/raxon/servus@sha256:${'a'.repeat(64)}`],['--ref','main']])
    fails(run(f,['main','--dry-run','--release','v0.1.52',...extra]),/cannot be combined/);
  f.env.SERVUS_REF='v0.1.52';
  fails(run(f,['main','--dry-run','--release','v0.1.52']),/source ref override/);
  assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('host domain settings accept only HTTPS origins and explicit booleans', () => {
  const f=fixture();
  succeeds(run(f,['validate_host_domain_settings','https://api.servus.run','true']));
  succeeds(run(f,['validate_host_domain_settings','','false']));
  fails(run(f,['validate_host_domain_settings','http://api.servus.run','true']),/must use HTTPS/);
  fails(run(f,['validate_host_domain_settings','https://api.servus.run/path','true']),/without a path/);
  fails(run(f,['validate_host_domain_settings','https://api.servus.run','yes']),/must be true or false/);
});
test('new installations use the live host registry by default and allow an explicit opt-out', () => {
  const f=fixture();
  delete f.env.SERVUS_HOST_DOMAINS_API_URL;delete f.env.SERVUS_HOST_DOMAINS_AUTOMATIC;
  const automatic=run(f,['main','--dry-run']);succeeds(automatic);
  assert.match(automatic.stdout,/New installation host domain API: https:\/\/api\.servus\.run/);
  assert.match(automatic.stdout,/Automatic host registration: true/);
  Object.assign(f.env,{SERVUS_HOST_DOMAINS_API_URL:'',SERVUS_HOST_DOMAINS_AUTOMATIC:'false'});
  const disabled=run(f,['main','--dry-run']);succeeds(disabled);
  assert.match(disabled.stdout,/New installation host domain API: disabled/);
  assert.match(disabled.stdout,/Automatic host registration: false/);
  assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('reruns preserve a stored host registry, including an explicitly empty one', () => {
  for(const api of ['', 'https://registry.example.test']) {
    const f=fixture();for(const p of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(p);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://localhost:4180\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\nSERVUS_HOST_DOMAINS_API_URL=${api}\nSERVUS_HOST_DOMAINS_AUTOMATIC=false\n`;
    writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);
    f.env.SERVUS_HOST_DOMAINS_API_URL='https://api.servus.run';
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; validate_host_domain_settings() { printf "host-registry=[%s] automatic=[%s]\\n" "$1" "$2"; }; main "$@"');
    fails(result,/intentional build failure/);
    assert.ok(result.stdout.includes(`host-registry=[${api}] automatic=[false]`));
    assert.equal(readFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),'utf8'),env);
  }
});
test('dry run validates a supported arm64 checkout without mutating the host', () => {
  const f=fixture();const r=run(f,['main','--dry-run','--source',f.source,'--port','4280','--ingress-port','28080']);succeeds(r);assert.match(r.stdout,/ubuntu 24.04 \(arm64\)/);assert.match(r.stdout,/Panel port: 4280/);assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('management binds to localhost by default and rejects a new public installation', () => {
  const f=fixture(); delete f.env.SERVUS_BIND_ADDRESS;
  const local=run(f,['main','--dry-run']);succeeds(local);assert.match(local.stdout,/Management bind address: 127\.0\.0\.1/);
  f.env.SERVUS_BIND_ADDRESS='0.0.0.0';
  fails(run(f,['main','--dry-run']),/cannot bind publicly/);
  fails(run(f,['main','--source',f.source]),/cannot bind publicly/);
  assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
  assert.equal(existsSync(f.env.SERVUS_CONFIG_DIR),false);
  assert.equal(existsSync(f.env.SERVUS_DATA_DIR),false);
  f.env.SERVUS_BIND_ADDRESS='127.0.0.1';f.env.SERVUS_PUBLIC_URL='https://panel.example.test';
  succeeds(run(f,['main','--dry-run']));
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
test('pinned image mode requires a matching registry digest and an explicit full commit', () => {
  const f=fixture(), digest='a'.repeat(64), image=`ghcr.io/raxon/servus@sha256:${digest}`, commit='b'.repeat(40);
  for(const invalid of ['', 'ghcr.io/raxon/servus:latest', `docker.io/raxon/servus@sha256:${digest}`, `ghcr.io/raxon/servus@sha256:${'a'.repeat(63)}`, `ghcr.io/raxon/servus@sha256:${'A'.repeat(64)}`]) {
    fails(run(f,['main','--dry-run','--image',invalid,'--ref',commit]),/Image must/);
  }
  fails(run(f,['main','--dry-run','--image',image]),/requires --ref/);
  for(const invalid of ['main','b'.repeat(39),'B'.repeat(40)]) fails(run(f,['main','--dry-run','--image',image,'--ref',invalid]),/requires --ref/);
  fails(run(f,['main','--dry-run','--image',image,'--ref',commit,'--source',f.source]),/cannot be combined/);
  const result=run(f,['main','--dry-run','--image',image,'--ref',commit]);succeeds(result);
  assert.match(result.stdout,new RegExp(`Image: ${image}`));
  assert.equal(existsSync(f.env.SERVUS_INSTALL_DIR),false);
});
test('swarm advertise address accepts a usable explicit IPv4 address', () => {
  const f=fixture();
  for(const invalid of ['','example.com','1.2.3','10.0.0.999','01.2.3.4','127.0.0.1','0.0.0.0','255.255.255.255','10.2.3.4;evil']) {
    fails(run(f,['main','--dry-run','--swarm-advertise-addr',invalid]),/Swarm advertise address|Invalid/);
  }
  const result=run(f,['main','--dry-run','--swarm-advertise-addr','10.19.0.6']);succeeds(result);
  assert.match(result.stdout,/Swarm advertise address: 10\.19\.0\.6/);
});
test('new swarm receives only the explicitly requested advertise address', () => {
  const f=fixture();f.env.SERVUS_TEST_ROOT=f.root;
  f.command('docker',`case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; swarm) printf '%s\\n' "$@" > "$SERVUS_TEST_ROOT/swarm-args";; build) echo "intentional build failure" >&2; exit 42;; *) exit 0;; esac`);
  fails(run(f,['--source',f.source,'--swarm-advertise-addr','10.19.0.6'],'source "$1"; shift; install_dependencies() { :; }; main "$@"'),/intentional build failure/);
  assert.deepEqual(readFileSync(join(f.root,'swarm-args'),'utf8').trim().split('\n'),['swarm','init','--advertise-addr','10.19.0.6']);
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
  const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://192.0.2.10:4180\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\n`;
  writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);writeFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'database-must-survive');
  fails(run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"'),/intentional build failure/);
  assert.equal(readFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),'utf8'),env);assert.equal(readFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'utf8'),'database-must-survive');assert.deepEqual(readdirSync(f.env.SERVUS_INSTALL_DIR).filter(n=>n.startsWith('.staging.')),[]);
});
test('failed update requires manual recovery without starting the previous image', () => {
  for(const failure of ['startup','readiness']) {
    const f=fixture();for(const p of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(p);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const previous=join(f.env.SERVUS_INSTALL_DIR,'releases/previous');mkdirSync(join(previous,'deployment'),{recursive:true});writeFileSync(join(previous,'deployment/compose.yaml'),'services: {}');symlinkSync(previous,join(f.env.SERVUS_INSTALL_DIR,'current'));
    const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://localhost:4180\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\n`;
    writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);
    const db=join(f.env.SERVUS_DATA_DIR,'panel.sqlite'), agent=join(f.env.SERVUS_DATA_DIR,'agent.sqlite');writeTestDatabase(db);writeFileSync(agent,'agent-database');const original=readFileSync(db);
    Object.assign(f.env,{SERVUS_TEST_ROOT:f.root,SERVUS_TEST_FAILURE:failure});
    f.command('stat','if [[ $2 == %u ]]; then echo 1000; else echo 0; fi');f.command('sleep','exit 0');f.command('seq','echo 1');f.command('curl','exit 22');
    f.command('docker',`case "$1" in
service) exit 1;; ps) exit 0;; info) echo inactive;; swarm|build) exit 0;;
compose) if [[ " $* " == *" up "* ]]; then
 if [[ -f $SERVUS_TEST_ROOT/up-called ]]; then touch "$SERVUS_TEST_ROOT/rollback-started"; exit 0; fi
 touch "$SERVUS_TEST_ROOT/up-called"; [[ $SERVUS_TEST_FAILURE == readiness ]] && exit 0; exit 17; fi;; esac`);
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"');
    fails(result,/Manual recovery required: the new panel did not become healthy/);
    assert.match(result.stderr,/previous image was not started.*Database migrations are not rolled back/i);
    assert.equal(existsSync(join(f.root,'rollback-started')),false);
    const retained=readdirSync(join(f.env.SERVUS_INSTALL_DIR,'releases')).find(name=>name.endsWith('-previous.env'));
    assert.ok(retained);assert.equal(readFileSync(join(f.env.SERVUS_INSTALL_DIR,'releases',retained),'utf8'),env);
    assert.deepEqual(readFileSync(db),original);assert.equal(readFileSync(agent,'utf8'),'agent-database');
    assert.equal(realpathSync(join(f.env.SERVUS_INSTALL_DIR,'current')),previous);
  }
});

test('an existing public installation cannot upgrade without a verifiable admin', () => {
  for (const state of ['missing', 'no-admin', 'admin', 'unreadable', 'symlink']) {
    const f=fixture();for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://192.0.2.10:4180\nSERVUS_BIND_ADDRESS=0.0.0.0\nSERVUS_IMAGE=previous-image\n`;
    const config=join(f.env.SERVUS_CONFIG_DIR,'servus.env'), db=join(f.env.SERVUS_DATA_DIR,'panel.sqlite');writeFileSync(config,env);
    if(state==='no-admin'||state==='admin') {
      const created=spawnSync('python3',['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE users(id TEXT, role TEXT)")
if sys.argv[2] == 'admin': c.execute("INSERT INTO users VALUES('admin-id','admin')")
c.commit();c.close()`,db,state],{encoding:'utf8'});assert.equal(created.status,0,created.stderr);
    } else if(state==='unreadable')writeFileSync(db,'invalid-database');
    else if(state==='symlink') {const target=join(f.root,'external');writeFileSync(target,'external-data');symlinkSync(target,db);}
    const original=existsSync(db)?readFileSync(db):null;
    f.env.SERVUS_TEST_DEPENDENCIES=join(f.root,'dependencies-called');
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { touch "$SERVUS_TEST_DEPENDENCIES"; }; main "$@"');
    fails(result,state==='admin'?/intentional build failure/:/no verifiable administrator/);
    assert.equal(readFileSync(config,'utf8'),env);
    assert.equal(existsSync(join(f.env.SERVUS_INSTALL_DIR,'install.lock')),true);
    assert.equal(existsSync(f.env.SERVUS_TEST_DEPENDENCIES),state==='admin');
    if(original)assert.deepEqual(readFileSync(db),original);
    else assert.equal(existsSync(db),false);
  }
});
test('admin check sees committed records in an open SQLite WAL', async () => {
  const f=fixture();mkdirSync(f.env.SERVUS_DATA_DIR);const db=join(f.env.SERVUS_DATA_DIR,'panel.sqlite');
  const writer=spawn('python3',['-u','-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA wal_autocheckpoint=0')
c.execute('CREATE TABLE users(id TEXT, role TEXT)');c.execute("INSERT INTO users VALUES('id','admin')");c.commit()
print('ready',flush=True);sys.stdin.read();c.close()`,db],{stdio:['pipe','pipe','pipe']});
  try {
    const [ready]=await once(writer.stdout,'data');assert.match(String(ready),/ready/);
    assert.ok(existsSync(`${db}-wal`));succeeds(run(f,['has_configured_admin',f.env.SERVUS_DATA_DIR]));
  } finally { writer.stdin.end();await once(writer,'exit'); }
});

test('image pull failure and revision mismatch preserve existing configuration and data', () => {
  for (const failure of ['pull','revision']) {
    const f=fixture(),commit='b'.repeat(40),image=`ghcr.io/raxon/servus@sha256:${'a'.repeat(64)}`;
    for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://192.0.2.10:4180\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\n`;
    writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);
    writeFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'existing-database');
    f.env.SERVUS_TEST_ROOT=f.root;f.env.SERVUS_TEST_FAILURE=failure;
    f.command('docker',`case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; swarm) exit 0;; pull) if [[ $SERVUS_TEST_FAILURE == pull ]]; then echo 'pull failed' >&2; exit 42; fi;; image) echo wrong-revision;; build|compose) touch "$SERVUS_TEST_ROOT/unexpected-command"; exit 90;; esac`);
    f.command('curl','touch "$SERVUS_TEST_ROOT/unexpected-command"; exit 90');
    const result=run(f,['--image',image,'--ref',commit],'source "$1"; shift; install_dependencies() { :; }; main "$@"');
    fails(result,failure==='pull'?/pull failed/:/revision label does not match/);
    assert.equal(readFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),'utf8'),env);
    assert.equal(readFileSync(join(f.env.SERVUS_DATA_DIR,'panel.sqlite'),'utf8'),'existing-database');
    assert.equal(existsSync(join(f.root,'unexpected-command')),false);
  }
});
test('pinned image uses matching source and retains the previous configuration on startup failure', () => {
  const f=fixture(),commit='b'.repeat(40),image=`ghcr.io/raxon/servus@sha256:${'a'.repeat(64)}`;
  for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
  writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
  const previous=join(f.env.SERVUS_INSTALL_DIR,'releases/previous');mkdirSync(join(previous,'deployment'),{recursive:true});writeFileSync(join(previous,'deployment/compose.yaml'),'services: {}');symlinkSync(previous,join(f.env.SERVUS_INSTALL_DIR,'current'));
  const env=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://192.0.2.10:4180\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\n`;
  writeFileSync(join(f.env.SERVUS_CONFIG_DIR,'servus.env'),env);const db=join(f.env.SERVUS_DATA_DIR,'panel.sqlite');writeTestDatabase(db);const original=readFileSync(db);
  const archiveFile=archive(f,[{name:'checkout/Dockerfile',data:'FROM scratch\n'},{name:'checkout/apps/panel/package.json',data:'{}'},{name:'checkout/deployment/compose.yaml',data:'# fixture\nservices: {}'},{name:'checkout/deployment/compose-supervised.yaml',data:'# /run/servus-lifecycle\nservices: {}'},{name:'checkout/deployment/lifecycle-gate.sh',data:'# fixture\n'}]);
  Object.assign(f.env,{SERVUS_TEST_ROOT:f.root,SERVUS_TEST_COMMIT:commit,SERVUS_TEST_ARCHIVE:archiveFile});
  f.command('stat','if [[ $2 == %u ]]; then echo 1000; else echo 0; fi');
  f.command('curl',`if [[ -f "$SERVUS_TEST_ROOT/rollback-started" ]]; then echo '{"status":"ok","version":"0.1.0"}'; exit 0; fi
[[ "$*" == *"https://github.com/raxon/servus/archive/$SERVUS_TEST_COMMIT.tar.gz"* ]] || exit 41
while [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then cp "$SERVUS_TEST_ARCHIVE" "$2"; exit; fi; shift; done
exit 42`);
  f.command('docker',`case "$1" in
service) exit 1;; ps) exit 0;; info) echo inactive;; swarm) exit 0;;
pull) printf '%s' "$2" > "$SERVUS_TEST_ROOT/pulled";; image) echo "$SERVUS_TEST_COMMIT";;
build) touch "$SERVUS_TEST_ROOT/built"; exit 42;;
compose) if [[ " $* " == *" up "* ]]; then
 if [[ ! -f $SERVUS_TEST_ROOT/up-called ]]; then cp "$3" "$SERVUS_TEST_ROOT/observed.env"; touch "$SERVUS_TEST_ROOT/up-called"; exit 17; fi
 touch "$SERVUS_TEST_ROOT/rollback-started"; fi;; esac`);
  const result=run(f,['--image',image,'--ref',commit],'source "$1"; shift; install_dependencies() { :; }; main "$@"');
  fails(result,/Manual recovery required.*previous image was not started/i);
  assert.equal(readFileSync(join(f.root,'pulled'),'utf8'),image);assert.equal(existsSync(join(f.root,'built')),false);
  assert.match(readFileSync(join(f.root,'observed.env'),'utf8'),new RegExp(`SERVUS_IMAGE=${image}`));
  assert.equal(existsSync(join(f.root,'rollback-started')),false);
  const retained=readdirSync(join(f.env.SERVUS_INSTALL_DIR,'releases')).find(name=>name.endsWith('-previous.env'));
  assert.ok(retained);assert.equal(readFileSync(join(f.env.SERVUS_INSTALL_DIR,'releases',retained),'utf8'),env);
  assert.deepEqual(readFileSync(db),original);
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

test('trusted proxy secret is validated without exposing it', () => {
  const f=fixture(), path=join(f.root,'config.env'), secret='a'.repeat(64);
  f.command('stat','echo 0:600');
  const inspect='source "$1"; shift; read_proxy_secret "$1"; [[ $proxy_secret == "$2" ]]';
  for(const content of ['', `SERVUS_TRUSTED_PROXY_SECRET=${secret}\n`]) {
    writeFileSync(path,content,{mode:0o600});
    const result=run(f,[path,content?secret:''],inspect);succeeds(result);
    assert.equal((result.stdout+result.stderr).includes(secret),false);
  }
  for(const content of ['SERVUS_TRUSTED_PROXY_SECRET=\n','SERVUS_TRUSTED_PROXY_SECRET=Z\n',`SERVUS_TRUSTED_PROXY_SECRET=${secret}\nSERVUS_TRUSTED_PROXY_SECRET=${secret}\n`,'SERVUS_TRUSTED_PROXY_SECRET\n']) {
    writeFileSync(path,content);const result=run(f,[path,secret],inspect);
    fails(result,/Invalid trusted proxy secret configuration/);
    assert.equal((result.stdout+result.stderr).includes(secret),false);
  }
  writeFileSync(path,`SERVUS_TRUSTED_PROXY_SECRET=${secret}\n`);
  f.command('stat','echo 0:644');fails(run(f,[path,secret],inspect),/root-owned and mode 0600/);
  writeFileSync(path,'SERVUS_TRUSTED_PROXY_SECRET_FILE=/secure/secret\n');
  fails(run(f,[path,secret],inspect),/File-based trusted proxy configuration is not supported/);
});

test('rerun retains only a valid stored proxy secret and does not log it', () => {
  for(const withSecret of [false,true]) {
    const f=fixture(), secret='b'.repeat(64);
    for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const config=join(f.env.SERVUS_CONFIG_DIR,'servus.env');
    const previous=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://localhost:4180\nSERVUS_ALLOWED_ORIGINS=http://localhost:4180,http://localhost:14480,https://panel.example.test:443,https://PANEL.EXAMPLE.TEST\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\n${withSecret?`SERVUS_TRUSTED_PROXY_SECRET=${secret}\n`:''}`;
    writeFileSync(config,previous,{mode:0o600});
    f.env.SERVUS_TRUSTED_PROXY_SECRET='c'.repeat(64);
    f.env.SERVUS_ALLOWED_ORIGINS='https://untrusted.example';
    f.command('stat','if [[ $2 == %u:%a ]]; then echo 0:600; elif [[ $2 == %u ]]; then echo 1000; else echo 0; fi');
    f.command('mv','if [[ $1 == -Tf ]]; then shift; /bin/mv -f "$@"; else /bin/mv "$@"; fi');
    f.command('docker','case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; *) exit 0;; esac');
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; wait_panel_ready() { :; }; main "$@"');
    succeeds(result);
    const updated=readFileSync(config,'utf8');
    assert.equal(updated.includes(`SERVUS_TRUSTED_PROXY_SECRET=${secret}\n`),withSecret);
    assert.equal(updated.includes('c'.repeat(64)),false);
    const origins=updated.match(/^SERVUS_ALLOWED_ORIGINS=(.*)$/m)[1].split(',');
    assert.deepEqual(origins,['http://localhost:4180','http://localhost:14480','https://panel.example.test','http://127.0.0.1:4180']);
    assert.equal(updated.includes('untrusted.example'),false);
    assert.equal((result.stdout+result.stderr).includes(secret),false);
    assert.equal((result.stdout+result.stderr).includes('c'.repeat(64)),false);
  }
});

test('saved origins reject malformed, unsafe and duplicate configuration without leaking values', () => {
  const f=fixture(), path=join(f.root,'config.env');
  f.command('stat','echo 0:600');
  const inspect='source "$1"; shift; read_saved_origins "$1"';
  for(const invalid of ['','*','https://*.example.test','https://safe.test/path','https://safe.test:99999','https://safe.test,,http://localhost:4180','https://safe.test,','http://evil.test','https://safe.test;echo']) {
    writeFileSync(path,`SERVUS_PUBLIC_URL=https://panel.example.test\nSERVUS_ALLOWED_ORIGINS=${invalid}\n`,{mode:0o600});
    const result=run(f,[path],inspect);fails(result,/Invalid saved origin configuration/);
    if(invalid)assert.equal((result.stdout+result.stderr).includes(invalid),false);
  }
  writeFileSync(path,'SERVUS_PUBLIC_URL=https://panel.example.test\nSERVUS_ALLOWED_ORIGINS=https://panel.example.test\nSERVUS_ALLOWED_ORIGINS=https://panel.example.test\n');
  fails(run(f,[path],inspect),/Invalid saved origin configuration/);
  writeFileSync(path,'SERVUS_PUBLIC_URL=https://panel.example.test\nSERVUS_PUBLIC_URL=https://other.example.test\nSERVUS_ALLOWED_ORIGINS=https://panel.example.test\n');
  fails(run(f,[path],inspect),/Invalid saved origin configuration/);
  f.command('stat','echo 0:644');
  writeFileSync(path,'SERVUS_PUBLIC_URL=https://panel.example.test\nSERVUS_ALLOWED_ORIGINS=https://panel.example.test\n');
  fails(run(f,[path],inspect),/root-owned and mode 0600/);
});

test('rerun rejects an invalid stored proxy secret before changing configuration', () => {
  const f=fixture(), invalid='bad-proxy-secret';
  for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
  writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
  const config=join(f.env.SERVUS_CONFIG_DIR,'servus.env');
  const previous=`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://localhost:4180\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_TRUSTED_PROXY_SECRET=${invalid}\n`;
  writeFileSync(config,previous,{mode:0o600});
  const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; main "$@"');
  fails(result,/Invalid trusted proxy secret configuration/);
  assert.equal(readFileSync(config,'utf8'),previous);
  assert.equal((result.stdout+result.stderr).includes(invalid),false);
});

test('rerun reads updated origins and secret after obtaining the installer lock', () => {
  const f=fixture(), oldSecret='d'.repeat(64), newSecret='e'.repeat(64);
  for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
  writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
  const config=join(f.env.SERVUS_CONFIG_DIR,'servus.env'), replacement=join(f.root,'replacement.env');
  const contents=(secret,origin)=>`SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DATA_DIR=${f.env.SERVUS_DATA_DIR}\nSERVUS_PUBLIC_URL=http://localhost:4180\nSERVUS_ALLOWED_ORIGINS=${origin}\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_IMAGE=previous-image\nSERVUS_TRUSTED_PROXY_SECRET=${secret}\n`;
  writeFileSync(config,contents(oldSecret,'https://old.example.test'),{mode:0o600});
  writeFileSync(replacement,contents(newSecret,'https://new.example.test'),{mode:0o600});
  f.env.SERVUS_TEST_REPLACEMENT=replacement;
  f.command('flock','cp "$SERVUS_TEST_REPLACEMENT" "$SERVUS_CONFIG_DIR/servus.env"');
  f.command('stat','if [[ $2 == %u:%a ]]; then echo 0:600; elif [[ $2 == %u ]]; then echo 1000; else echo 0; fi');
  f.command('mv','if [[ $1 == -Tf ]]; then shift; /bin/mv -f "$@"; else /bin/mv "$@"; fi');
  f.command('docker','case "$1" in service) exit 1;; ps) exit 0;; info) echo inactive;; *) exit 0;; esac');
  const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { :; }; wait_panel_ready() { :; }; main "$@"');
  succeeds(result);
  const updated=readFileSync(config,'utf8');
  assert.equal(updated.includes(`SERVUS_TRUSTED_PROXY_SECRET=${newSecret}\n`),true);
  assert.equal(updated.includes(oldSecret),false);
  assert.equal(updated.includes('https://new.example.test'),true);
  assert.equal(updated.includes('https://old.example.test'),false);
  assert.equal((result.stdout+result.stderr).includes(newSecret),false);
});

test('unfinished origin migration blocks installation, including a dangling symlink', () => {
  for(const symlink of [false,true]) {
    const f=fixture();for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const pending=join(f.env.SERVUS_CONFIG_DIR,'servus-origin-migration.pending');
    if(symlink)symlinkSync(join(f.root,'absent'),pending);else writeFileSync(pending,'pending');
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { touch "$SERVUS_DATA_DIR/dependencies"; }; main "$@"');
    fails(result,/unfinished origin migration requires recovery/);
    assert.equal(existsSync(join(f.env.SERVUS_DATA_DIR,'dependencies')),false);
  }
});

test('unfinished initial handoff blocks installation, including a dangling symlink', () => {
  for(const symlink of [false,true]) {
    const f=fixture();for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const pending=join(f.env.SERVUS_INSTALL_DIR,'.initial-handoff-v1');
    if(symlink)symlinkSync(join(f.root,'absent'),pending);else writeFileSync(pending,'pending');
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { touch "$SERVUS_DATA_DIR/dependencies"; }; main "$@"');
    fails(result,/initial handoff requires recovery/);
    assert.equal(existsSync(join(f.env.SERVUS_DATA_DIR,'dependencies')),false);
  }
});

test('unfinished bootstrap verification blocks installation, including a dangling symlink', () => {
  for(const symlink of [false,true]) {
    const f=fixture();for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const pending=join(f.env.SERVUS_INSTALL_DIR,'.bootstrap-verification-v1');
    if(symlink)symlinkSync(join(f.root,'absent'),pending);else writeFileSync(pending,'pending');
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { touch "$SERVUS_DATA_DIR/dependencies"; }; main "$@"');
    fails(result,/bootstrap verification requires recovery/);
    assert.equal(existsSync(join(f.env.SERVUS_DATA_DIR,'dependencies')),false);
  }
});

test('unfinished legacy migration blocks installation, including a dangling symlink', () => {
  for(const symlink of [false,true]) {
    const f=fixture();for(const path of [f.env.SERVUS_INSTALL_DIR,f.env.SERVUS_CONFIG_DIR,f.env.SERVUS_DATA_DIR])mkdirSync(path);
    writeFileSync(join(f.env.SERVUS_INSTALL_DIR,'.servus-install'),'servus-installer-v1\n');
    const pending=join(f.env.SERVUS_INSTALL_DIR,'.legacy-migration-v1');
    if(symlink)symlinkSync(join(f.root,'absent'),pending);else writeFileSync(pending,'pending');
    const result=run(f,['--source',f.source],'source "$1"; shift; install_dependencies() { touch "$SERVUS_DATA_DIR/dependencies"; }; main "$@"');
    fails(result,/legacy migration requires recovery/);
    assert.equal(existsSync(join(f.env.SERVUS_DATA_DIR,'dependencies')),false);
  }
});

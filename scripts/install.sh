#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
servus_staging=
servus_config_temp=
servus_probe_container=
servus_docker_config=

fail() { printf 'Servus: %s\n' "$*" >&2; return 1; }
log() { printf 'Servus: %s\n' "$*"; }
trusted_docker() {
  # Docker and Compose must not inherit host interpolation, context or plugin settings.
  [[ -n $servus_docker_config ]] || fail 'Isolated Docker client configuration is unavailable.'
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root DOCKER_CONFIG="$servus_docker_config" DOCKER_CONTEXT=default DOCKER_HOST=unix:///var/run/docker.sock /usr/bin/docker "$@"
}
prepare_docker_client() {
  [[ ! -L $config_dir && $(stat -c '%u:%g:%a' "$config_dir") == 0:0:700 ]] || fail 'Configuration directory must be root-owned and mode 0700.'
  servus_docker_config=$(mktemp -d "$config_dir/.docker-cli.XXXXXXXX")
}
print_success() {
  printf '\nConfigured panel origin: %s\nManagement listener: %s:%s\nOpen the configured origin to sign in, or create the first local administrator if setup is required.\nManage: docker compose --env-file %s -f %s/current/deployment/compose.yaml -p servus ps\n' "$1" "${4:-127.0.0.1}" "${5:-4180}" "$2" "$3"
}
wait_panel_ready() {
  local port=$1 attempt
  for attempt in $(seq 1 90); do
    if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$port/api/v1/health" | python3 -c 'import json,sys; value=json.load(sys.stdin); sys.exit(0 if value.get("status")=="ok" and isinstance(value.get("version"),str) else 1)' 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

usage() {
  cat <<'USAGE'
Usage: install.sh [--dry-run] [--source DIRECTORY | --image IMAGE] [--ref REF] [--hostname HOST]
                  [--port PORT] [--ingress-port PORT] [--swarm-advertise-addr IPV4] [--help]

Installs Servus on Ubuntu 22.04/24.04/26.04 or Debian 12/13 (amd64/arm64).
Run as root. Existing Servus data and configuration are retained on rerun.
--dry-run validates input and prints the plan without modifying the host.
--source builds an existing local monorepo instead of downloading GitHub source.
--ref selects a GitHub branch, tag or commit (default: main).
--image pulls ghcr.io/raxon/servus by sha256 digest instead of building.
        Requires --ref with the 40-character Git commit recorded in the image label.
--hostname sets the panel HTTP hostname. HTTPS needs a separate reverse proxy.
--swarm-advertise-addr selects an IPv4 address when initializing a new Docker Swarm.
Environment: SERVUS_INSTALL_DIR, SERVUS_CONFIG_DIR, SERVUS_DATA_DIR,
             SERVUS_PUBLIC_URL, SERVUS_BIND_ADDRESS (default 127.0.0.1; 0.0.0.0 is an explicit override).
The public website and installer URL use servus.run. Customer panels use their
own VPS hostname or IP address.
USAGE
}
validate_port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )) || fail "Invalid port: $1"; }
validate_host() {
  local host=$1
  [[ ${#host} -le 253 && $host =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]] || fail "Invalid hostname: $host"
  if [[ $host =~ ^[0-9.]+$ ]]; then
    local a b c d octet
    IFS=. read -r a b c d <<< "$host"
    for octet in "$a" "$b" "$c" "$d"; do
      [[ $octet =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( 10#$octet <= 255 )) || fail "Invalid IPv4 address: $host"
    done
  fi
}
validate_path() { [[ $1 =~ ^/[a-zA-Z0-9._/-]+$ && $1 != / && $1 != *..* && $1 != */ ]] || fail "Invalid absolute directory: $1"; }
check_path_ancestors() {
  local path=$1
  while [[ $path != / ]]; do
    [[ ! -L $path ]] || fail "Symlink in installation path: $path"
    path=${path%/*}; path=${path:-/}
  done
}
cleanup_staging() {
  if [[ $servus_probe_container =~ ^[0-9a-f]{64}$ ]]; then trusted_docker rm "$servus_probe_container" >/dev/null 2>&1 || :; servus_probe_container=; fi
  if [[ -n $servus_staging ]]; then rm -rf -- "$servus_staging"; servus_staging=; fi
  if [[ -n $servus_config_temp ]]; then rm -f -- "$servus_config_temp"; servus_config_temp=; fi
  if [[ -n $servus_docker_config ]]; then rm -rf -- "$servus_docker_config"; servus_docker_config=; fi
}
validate_image() { [[ $1 =~ ^ghcr\.io/raxon/servus@sha256:[0-9a-f]{64}$ ]] || fail 'Image must be ghcr.io/raxon/servus with a lowercase sha256 digest.'; }
validate_ref() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$ && $1 != *..* && $1 != */ && $1 != *//* ]] || fail 'Invalid source ref.'; }
validate_origin() {
  [[ $1 =~ ^https?://([a-zA-Z0-9][a-zA-Z0-9.-]*)(:([0-9]{1,5}))?$ ]] || fail 'SERVUS_PUBLIC_URL must be an HTTP(S) origin without a path.'
  local host=${BASH_REMATCH[1]} port=${BASH_REMATCH[3]:-}
  validate_host "$host"
  [[ -z $port ]] || validate_port "$port"
}
validate_host_domain_settings() {
  [[ $2 == true || $2 == false ]] || fail 'SERVUS_HOST_DOMAINS_AUTOMATIC must be true or false.'
  if [[ -n $1 ]]; then
    [[ $1 == https://* ]] || fail 'SERVUS_HOST_DOMAINS_API_URL must use HTTPS.'
    validate_origin "$1"
  fi
}
normalize_origin() {
  validate_origin "$1"
  local value=${1,,} scheme authority port
  scheme=${value%%://*}; authority=${value#*://}
  if [[ $authority =~ :([0-9]+)$ ]]; then
    port=$((10#${BASH_REMATCH[1]})); authority=${authority%:*}
    if [[ $scheme == http && $port == 80 || $scheme == https && $port == 443 ]]; then
      printf '%s://%s' "$scheme" "$authority"
    else printf '%s://%s:%s' "$scheme" "$authority" "$port"; fi
  else printf '%s' "$value"; fi
}
detect_platform() {
  [[ $(uname -s) == Linux ]] || fail 'The installer requires Linux.'
  local os_file=${SERVUS_OS_RELEASE:-/etc/os-release} key value
  [[ -r $os_file ]] || fail 'Cannot read /etc/os-release.'
  os_id= os_version= os_codename=
  while IFS='=' read -r key value; do
    value=${value#\"}; value=${value%\"}
    case "$key" in ID) os_id=$value;; VERSION_ID) os_version=$value;; VERSION_CODENAME) os_codename=$value;; esac
  done < "$os_file"
  case "$os_id:$os_version" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
    *) fail "Unsupported distribution: $os_id $os_version";;
  esac
  [[ $os_codename =~ ^[a-z]+$ ]] || fail 'Missing or invalid distribution codename.'
  case "$(uname -m)" in x86_64|amd64) architecture=amd64;; aarch64|arm64) architecture=arm64;; *) fail 'Use an amd64 or arm64 VPS.';; esac
}
read_setting() { awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$config_file"; }
has_setting() { awk -F= -v key="$1" '$1 == key {found=1; exit} END {exit !found}' "$config_file"; }
canonical_saved_origin() {
  local value=${1,,} scheme host port octet a b c d
  [[ $value =~ ^(https?)://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)(:([0-9]{1,5}))?$ ]] || return 1
  scheme=${BASH_REMATCH[1]}; host=${BASH_REMATCH[2]}; port=${BASH_REMATCH[7]:-}
  [[ ${#host} -le 253 ]] || return 1
  if [[ $host =~ ^[0-9.]+$ ]]; then
    [[ $host =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    IFS=. read -r a b c d <<< "$host"
    for octet in "$a" "$b" "$c" "$d"; do
      [[ $octet =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( 10#$octet <= 255 )) || return 1
    done
  fi
  if [[ -n $port ]]; then
    (( 10#$port >= 1 && 10#$port <= 65535 )) || return 1
    port=$((10#$port))
    [[ $scheme != http || $port != 80 ]] && [[ $scheme != https || $port != 443 ]] || port=
  fi
  printf '%s://%s%s' "$scheme" "$host" "${port:+:$port}"
}
append_origin() {
  local item=$1
  case ",$allowed_origins," in *",$item,"*) ;; *) allowed_origins+="${allowed_origins:+,}$item";; esac
}
read_saved_origins() {
  local file=$1 line count=0 public_count=0 raw= item canonical stored_public= public_host
  saved_origins=
  [[ -f $file ]] || return 0
  [[ ! -L $file ]] || fail 'Configuration must not be a symlink.'
  while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in
      SERVUS_PUBLIC_URL|SERVUS_PUBLIC_URL=*)
        ((public_count+=1))
        [[ $line == SERVUS_PUBLIC_URL=* ]] || fail 'Invalid saved origin configuration.'
        stored_public=${line#*=}
        ;;
      SERVUS_ALLOWED_ORIGINS|SERVUS_ALLOWED_ORIGINS=*)
        ((count+=1))
        [[ $count == 1 && $line == SERVUS_ALLOWED_ORIGINS=* ]] || fail 'Invalid saved origin configuration.'
        raw=${line#*=}
        ;;
    esac
  done < "$file"
  (( count )) || return 0
  [[ $(stat -c '%u:%a' "$file") == 0:600 ]] || fail 'Saved origin configuration must be root-owned and mode 0600.'
  [[ -n $raw && $raw != ,* && $raw != *, && $raw != *,,* ]] || fail 'Invalid saved origin configuration.'
  [[ $public_count == 1 ]] || fail 'Invalid saved origin configuration.'
  stored_public=$(canonical_saved_origin "$stored_public") || fail 'Invalid saved origin configuration.'
  local allowed_origins=
  while [[ -n $raw ]]; do
    item=${raw%%,*}
    if [[ $raw == *,* ]]; then raw=${raw#*,}; else raw=; fi
    canonical=$(canonical_saved_origin "$item") || fail 'Invalid saved origin configuration.'
    public_host=${canonical#http://}; public_host=${public_host%%:*}
    [[ $canonical == https://* || $canonical == "$stored_public" || $public_host == localhost || $public_host == 127.0.0.1 ]] || fail 'Invalid saved origin configuration.'
    append_origin "$canonical"
  done
  saved_origins=$allowed_origins
}
read_proxy_secret() {
  local file=$1 line count=0
  proxy_secret=
  [[ -f $file ]] || return 0
  [[ ! -L $file ]] || fail 'Configuration must not be a symlink.'
  while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in
      SERVUS_TRUSTED_PROXY_SECRET_FILE|SERVUS_TRUSTED_PROXY_SECRET_FILE=*)
        fail 'File-based trusted proxy configuration is not supported by this installer.'
        ;;
      SERVUS_TRUSTED_PROXY_SECRET|SERVUS_TRUSTED_PROXY_SECRET=*)
        ((count+=1))
        [[ $count == 1 && $line == SERVUS_TRUSTED_PROXY_SECRET=* ]] || fail 'Invalid trusted proxy secret configuration.'
        proxy_secret=${line#*=}
        [[ $proxy_secret =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid trusted proxy secret configuration.'
        ;;
    esac
  done < "$file"
  if (( count )); then
    [[ $(stat -c '%u:%a' "$file") == 0:600 ]] || fail 'Trusted proxy configuration must be root-owned and mode 0600.'
  fi
}
has_configured_admin() {
  local db=$1/panel.sqlite
  [[ -f $db && ! -L $db && ! -L $db-wal && ! -L $db-shm ]] || return 1
  python3 - "$db" <<'PYADMIN'
import pathlib, sqlite3, sys
try:
    path = pathlib.Path(sys.argv[1])
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        connection.execute('PRAGMA query_only=ON')
        row = connection.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        sys.exit(0 if row else 1)
    finally:
        connection.close()
except (OSError, sqlite3.Error, ValueError):
    sys.exit(1)
PYADMIN
}
prepare_lifecycle_gate() {
  # This operates under install.lock. Lifecycle lock inodes must never be replaced.
  python3 -I - "$config_dir" "$install_dir" <<'PYGATE'
import fcntl, os, pathlib, stat, sys

class Unsafe(Exception): pass

def directory(path):
    path = pathlib.PurePosixPath(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = new
            info = os.fstat(fd)
            if info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise Unsafe('Untrusted lifecycle ancestor')
        return fd
    except BaseException:
        os.close(fd); raise

def open_file(parent, name, mode):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
        os.close(fd); raise Unsafe('Untrusted lifecycle file')
    return fd

def create_file(parent, name, value, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
    try:
        os.fchmod(fd, mode)
        os.write(fd, value)
        os.fsync(fd)
    finally: os.close(fd)

def exists(parent, name):
    try: os.stat(name, dir_fd=parent, follow_symlinks=False); return True
    except FileNotFoundError: return False

try:
    if os.geteuid() != 0: raise Unsafe('Lifecycle preparation requires root')
    config = directory(sys.argv[1]); install = directory(sys.argv[2])
    marker, gate = '.lifecycle-enabled-v1', 'lifecycle'
    marked, present = exists(install, marker), exists(config, gate)
    if marked != present: raise Unsafe('Incomplete lifecycle gate requires manual recovery')
    content = b''
    if exists(config, 'servus.env'):
        env = open_file(config, 'servus.env', 0o600)
        try: content = os.read(env, 65537)
        finally: os.close(env)
        if len(content) > 65536: raise Unsafe('Existing configuration is too large')
        lifecycle = [line for line in content.splitlines() if line == b'SERVUS_LIFECYCLE_DIR' or line.startswith(b'SERVUS_LIFECYCLE_DIR=')]
        expected = ('SERVUS_LIFECYCLE_DIR=' + sys.argv[1] + '/lifecycle').encode('ascii')
        if len(lifecycle) > 1 or (lifecycle and lifecycle[0] != expected): raise Unsafe('Invalid existing lifecycle configuration')
    if not marked:
        # An existing lifecycle configuration must never be recreated as normal.
        if exists(config, 'servus.env'):
            if any(line == b'SERVUS_LIFECYCLE_DIR' or line.startswith(b'SERVUS_LIFECYCLE_DIR=') for line in content.splitlines()):
                raise Unsafe('Existing lifecycle configuration requires manual recovery')
            current = pathlib.Path(sys.argv[2]) / 'current' / 'deployment' / 'compose.yaml'
            if not current.is_file() or '/run/servus-lifecycle' in current.read_text():
                raise Unsafe('Existing lifecycle installation requires manual recovery')
        os.mkdir(gate, 0o755, dir_fd=config)
        gate_fd = os.open(gate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
        try:
            os.fchmod(gate_fd, 0o755)
            create_file(gate_fd, 'lock', b'', 0o644)
            create_file(gate_fd, 'state', b'servus-lifecycle-v1 normal\n', 0o644)
            os.fsync(gate_fd); os.fsync(config)
        finally: os.close(gate_fd)
        create_file(install, marker, b'servus-lifecycle-v1\n', 0o600)
        os.fsync(install)
    marker_fd = open_file(install, marker, 0o600)
    try:
        if os.read(marker_fd, 64) != b'servus-lifecycle-v1\n': raise Unsafe('Unrecognized lifecycle marker')
    finally: os.close(marker_fd)
    gate_fd = os.open(gate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
    try:
        info = os.fstat(gate_fd)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755: raise Unsafe('Untrusted lifecycle directory')
        lock = open_file(gate_fd, 'lock', 0o644)
        try:
            try: fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError: raise Unsafe('Lifecycle gate is locked for maintenance')
            by_name = os.stat('lock', dir_fd=gate_fd, follow_symlinks=False)
            by_fd = os.fstat(lock)
            if (by_name.st_dev, by_name.st_ino) != (by_fd.st_dev, by_fd.st_ino): raise Unsafe('Lifecycle lock changed')
            state = open_file(gate_fd, 'state', 0o644)
            try:
                if os.read(state, 128) != b'servus-lifecycle-v1 normal\n': raise Unsafe('Lifecycle gate is not in normal state')
            finally: os.close(state)
        finally: os.close(lock)
    finally: os.close(gate_fd)
    os.close(config); os.close(install)
except (Unsafe, OSError, UnicodeError) as error:
    print('Servus: Lifecycle gate rejected installation: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYGATE
}
prepare_supervisor_credentials() {
  # Install lock must cover provisioning; existing credentials are never rotated here.
  python3 -I - "$config_dir" "$install_dir" <<'PYSUPERVISOR'
import os, pathlib, re, secrets, stat, sys

class Unsafe(Exception): pass

def trusted_directory(path):
    value = pathlib.PurePosixPath(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in value.parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = new
            info = os.fstat(fd)
            if info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX): raise Unsafe('Untrusted supervisor ancestor')
        return fd
    except BaseException:
        os.close(fd); raise

def exists(directory, name):
    try: os.stat(name, dir_fd=directory, follow_symlinks=False); return True
    except FileNotFoundError: return False

def create_file(directory, name, data, mode, gid):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
    try:
        os.fchown(fd, 0, gid); os.fchmod(fd, mode)
        written = 0
        while written < len(data):
            count = os.write(fd, data[written:])
            if count <= 0: raise Unsafe('A supervisor file could not be written')
            written += count
        os.fsync(fd)
    finally: os.close(fd)

def open_file(directory, name, mode, gid):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
        os.close(fd); raise Unsafe('A supervisor file is unsafe')
    return fd

def child(directory, name, mode, gid):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
        os.close(fd); raise Unsafe('A supervisor directory is unsafe')
    return fd

try:
    if os.geteuid() != 0: raise Unsafe('Supervisor provisioning requires root')
    config, install = trusted_directory(sys.argv[1]), trusted_directory(sys.argv[2])
    secret_name, control_name, marker = 'supervisor-secrets', 'supervisor-control', '.supervisor-enabled-v1'
    presence = [exists(config, name) for name in (secret_name, control_name, marker)]
    if any(presence) and not all(presence): raise Unsafe('Incomplete supervisor provisioning requires recovery')
    settings = []
    if exists(config, 'servus.env'):
        fd = open_file(config, 'servus.env', 0o600, 0)
        try: content = os.read(fd, 65537)
        finally: os.close(fd)
        if len(content) > 65536: raise Unsafe('Existing configuration is too large')
        settings = [line for line in content.splitlines() if line.split(b'=',1)[0] in (b'SERVUS_SUPERVISOR_CONTROL_DIR', b'SERVUS_SUPERVISOR_SECRET_DIR')]
        expected = {('SERVUS_SUPERVISOR_CONTROL_DIR=' + sys.argv[1] + '/supervisor-control').encode('ascii'), ('SERVUS_SUPERVISOR_SECRET_DIR=' + sys.argv[1] + '/supervisor-secrets').encode('ascii')}
        if settings and (len(settings) != 2 or set(settings) != expected): raise Unsafe('Existing supervisor configuration is invalid')
    if not any(presence):
        if settings: raise Unsafe('Existing supervisor provisioning requires recovery')
        if exists(config, 'servus.env'):
            compose = pathlib.Path(sys.argv[2]) / 'current' / 'deployment' / 'compose.yaml'
            if not compose.is_file() or '/run/servus-supervisor' in compose.read_text(): raise Unsafe('Existing supervisor installation requires recovery')
        os.mkdir(secret_name, 0o700, dir_fd=config)
        secret_dir = child(config, secret_name, 0o700, 0)
        try:
            tokens = set()
            for role in ('api', 'worker', 'agent'):
                token = secrets.token_hex(32)
                if token in tokens: raise Unsafe('Unable to provision distinct supervisor credentials')
                tokens.add(token)
                create_file(secret_dir, role, (token + '\n').encode('ascii'), 0o640, 1000)
            os.fsync(secret_dir)
        finally: os.close(secret_dir)
        os.mkdir(control_name, 0o750, dir_fd=config)
        control_dir = os.open(control_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
        try:
            os.fchown(control_dir, 0, 1000); os.fchmod(control_dir, 0o750); os.fsync(control_dir)
        finally: os.close(control_dir)
        os.fsync(config)
        create_file(config, marker, b'servus-supervisor-v1\n', 0o600, 0)
        os.fsync(config)
    marker_fd = open_file(config, marker, 0o600, 0)
    try:
        if os.read(marker_fd, 64) != b'servus-supervisor-v1\n': raise Unsafe('Invalid supervisor marker')
    finally: os.close(marker_fd)
    secret_dir = child(config, secret_name, 0o700, 0)
    control_dir = child(config, control_name, 0o750, 1000)
    try:
        tokens = set()
        for role in ('api', 'worker', 'agent'):
            fd = open_file(secret_dir, role, 0o640, 1000)
            try: raw = os.read(fd, 66)
            finally: os.close(fd)
            if not re.fullmatch(b'[a-f0-9]{64}\n', raw) or raw in tokens: raise Unsafe('A supervisor credential is unsafe')
            tokens.add(raw)
    finally:
        os.close(secret_dir); os.close(control_dir)
    os.close(config); os.close(install)
except (Unsafe, OSError, UnicodeError) as error:
    print('Servus: Supervisor provisioning was rejected: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYSUPERVISOR
}
prepare_runtime() {
  python3 -I "$1/apps/updater/provision-host.py" --runtime --config-dir "$config_dir" --install-dir "$install_dir" --install-lock-fd 9
}
require_supervisor_socket() {
  python3 -I - "$config_dir/supervisor-control" <<'PYSOCKET'
import os, socket, stat, sys
try:
    directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_gid != 1000 or stat.S_IMODE(info.st_mode) != 0o750: raise ValueError()
        entry = os.stat('socket', dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != 0 or entry.st_gid != 1000 or stat.S_IMODE(entry.st_mode) != 0o660: raise ValueError()
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(2)
            probe.connect('/proc/self/fd/' + str(directory) + '/socket')
            current = os.stat('socket', dir_fd=directory, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (entry.st_dev, entry.st_ino): raise ValueError()
        finally: probe.close()
    finally: os.close(directory)
except (OSError, ValueError):
    print('Servus: A root-owned supervisor socket is required before starting the panel.', file=sys.stderr)
    sys.exit(1)
PYSOCKET
}
inspect_lifecycle_file() {
  local container_id=$1 path=$2 mode=$3 expected=${4:-}
  trusted_docker cp "$container_id:$path" - 2>/dev/null | python3 -I -c '
import sys, tarfile
try:
    limit = 1048576 if sys.argv[1] == "script" else 16777216
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as archive:
        member = archive.next()
        if not member or not member.isfile() or member.size <= 0 or member.size > limit or (sys.argv[1] == "tool" and not member.mode & 0o111): raise ValueError()
        source = archive.extractfile(member)
        if source is None: raise ValueError()
        data = source.read(limit + 1)
        if len(data) != member.size or len(data) > limit or archive.next() is not None: raise ValueError()
        if sys.argv[1] == "script":
            with open(sys.argv[2], "rb") as expected: reference = expected.read(limit + 1)
            if len(reference) > limit or data != reference: raise ValueError()
except (OSError, ValueError, tarfile.TarError):
    print("Servus: The image lifecycle component is invalid.", file=sys.stderr)
    sys.exit(1)
' "$mode" "$expected"
}
verify_lifecycle_image() {
  local image=$1 expected=$2 staging=$3 container_id result=1 tool
  [[ -f $expected && ! -L $expected ]] || fail 'The release does not include a regular lifecycle gate.'
  trusted_docker image inspect --format '{{json .Config.Env}}' "$image" | head -c 65537 > "$staging/lifecycle-image-env.json" || fail 'Cannot inspect the lifecycle image environment.'
  trusted_docker image inspect --format '{{json .Config.User}}' "$image" | head -c 1025 > "$staging/lifecycle-image-user.json" || fail 'Cannot inspect the lifecycle image user.'
  python3 -I -c '
import json, sys
try:
    with open(sys.argv[1], "rb") as stream: data = stream.read(1025)
    if len(data) > 1024 or json.loads(data) != "node": raise ValueError()
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    print("Servus: The image user is invalid.", file=sys.stderr)
    sys.exit(1)
' "$staging/lifecycle-image-user.json" || return 1
  python3 -I -c '
import json, re, sys
try:
    with open(sys.argv[1], "rb") as stream: data = stream.read(65537)
    if len(data) > 65536: raise ValueError()
    values = json.loads(data)
    if not isinstance(values, list): raise ValueError()
    environment = {}
    for item in values:
        if not isinstance(item, str) or "=" not in item: raise ValueError()
        key, value = item.split("=", 1)
        if not key or key in environment: raise ValueError()
        environment[key] = value
    expected = {"PATH", "NODE_VERSION", "YARN_VERSION", "NODE_ENV", "PANEL_DATA_DIR", "PANEL_HOST", "PANEL_PORT"}
    if set(environment) != expected: raise ValueError()
    if environment["PATH"] != "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin": raise ValueError()
    if not re.fullmatch(r"24\.[0-9]+\.[0-9]+", environment["NODE_VERSION"]) or not re.fullmatch(r"1\.[0-9]+\.[0-9]+", environment["YARN_VERSION"]): raise ValueError()
    if environment["NODE_ENV"] != "production" or environment["PANEL_DATA_DIR"] != "/var/lib/panel" or environment["PANEL_HOST"] != "0.0.0.0" or environment["PANEL_PORT"] != "4180": raise ValueError()
except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
    print("Servus: The image environment is invalid.", file=sys.stderr)
    sys.exit(1)
' "$staging/lifecycle-image-env.json" || return 1
  container_id=$(trusted_docker create --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --entrypoint /bin/sh "$image" -c true) || fail 'Cannot inspect the lifecycle image.'
  [[ $container_id =~ ^[0-9a-f]{64}$ ]] || fail 'Docker returned an invalid inspection container.'
  servus_probe_container=$container_id
  if inspect_lifecycle_file "$container_id" '/app/lifecycle-gate.sh' script "$expected"; then
    result=0
    if ! inspect_lifecycle_file "$container_id" '/app/dist/shared/supervisor-entrypoint.js' data; then result=1; fi
    for tool in flock findmnt cmp stat; do
      if ! inspect_lifecycle_file "$container_id" "/usr/bin/$tool" tool; then result=1; fi
    done
  fi
  trusted_docker rm "$container_id" >/dev/null || fail 'Cannot remove the lifecycle inspection container.'
  servus_probe_container=
  (( result == 0 )) || fail 'The image lifecycle gate does not match the release.'
}
verify_lifecycle_compose() {
  local env_file=$1 compose_file=$2 lifecycle_dir=$3 expected_image=$4 data_dir=$5 image_env_file=$6 control_dir=$7 secret_dir=$8 canonical_out=$9
  trusted_docker compose --env-file "$env_file" -f "$compose_file" -p servus config --format json |
    python3 -I "$source/apps/updater/validate-compose.py" "$lifecycle_dir" "$expected_image" "$data_dir" "$env_file" "$image_env_file" "$control_dir" "$secret_dir" "$canonical_out"
}
install_dependencies() {
  command -v apt-get >/dev/null || fail 'apt-get is required.'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3 nodejs iproute2 util-linux
  if [[ ! -x /usr/bin/docker ]]; then
    install -d -m 0755 /etc/apt/keyrings
    curl --proto '=https' --tlsv1.2 -fsSL "https://download.docker.com/linux/$os_id/gpg" -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$os_id" "$os_codename" "$architecture" > /etc/apt/sources.list.d/docker.sources
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  command -v systemctl >/dev/null || fail 'A systemd VPS is required.'
  systemctl enable --now docker
  trusted_docker info >/dev/null
  trusted_docker compose version >/dev/null || fail 'Docker Compose plugin is missing. Install docker-compose-plugin, then retry.'
  [[ -S /var/run/docker.sock ]] || fail 'The system Docker socket /var/run/docker.sock is required.'
}
check_port() {
  local port=$1 role=$2 listener owned=
  listener=$(ss -H -ltn "sport = :$port")
  [[ -n $listener ]] || return 0
  if [[ -f $install_dir/.servus-install ]]; then
    if [[ $role == api ]]; then
      owned=$(trusted_docker ps --filter label=com.docker.compose.project=servus --filter label=com.docker.compose.service=api --filter "publish=$port" --format '{{.ID}}')
    else
      owned=$(trusted_docker service inspect panel-ingress --format '{{index .Spec.Labels "panel.owner"}}' 2>/dev/null || true)
      [[ $owned == self-hosted-panel ]] || owned=
    fi
  fi
  [[ -n $owned ]] || fail "TCP port $port is occupied. Choose another port or release it before installing."
}
extract_source() {
  python3 - "$1" "$2" <<'PY'
import pathlib, shutil, sys, tarfile
archive, destination = sys.argv[1:]
root = pathlib.Path(destination)
with tarfile.open(archive, 'r:*') as source:
    members = source.getmembers()
    tops = set()
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        if name.is_absolute() or '..' in name.parts or not name.parts:
            raise SystemExit('Unsafe source archive path')
        if not (item.isfile() or item.isdir()):
            raise SystemExit('Source archive contains a link or special file')
        tops.add(name.parts[0])
    if len(tops) != 1:
        raise SystemExit('Source archive must contain one root directory')
    for item in members:
        parts = pathlib.PurePosixPath(item.name).parts[1:]
        if not parts:
            continue
        target = root.joinpath(*parts)
        if item.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(item) as incoming, target.open('wb') as output:
                shutil.copyfileobj(incoming, output)
            target.chmod(0o755 if item.mode & 0o111 else 0o644)
PY
}


main() {
  unset SERVUS_TRUSTED_PROXY_SECRET PANEL_TRUSTED_PROXY_SECRET SERVUS_TRUSTED_PROXY_SECRET_FILE PANEL_TRUSTED_PROXY_SECRET_FILE SERVUS_ALLOWED_ORIGINS SERVUS_LIFECYCLE_DIR SERVUS_SUPERVISOR_CONTROL_DIR SERVUS_SUPERVISOR_SECRET_DIR SERVUS_UPDATER_SOCKET_DIR PANEL_UPDATER_SOCKET PANEL_UPDATER_APPLY_ENABLED PANEL_SUPERVISOR_SOCKET PANEL_SUPERVISOR_SECRET_FILE
  local proxy_secret= saved_origins=
  local dry_run=0 source_dir= hostname= image_ref= swarm_advertise_addr= ref_explicit=0 ref=${SERVUS_REF:-main} port=4180 ingress_port=80
  local install_dir=${SERVUS_INSTALL_DIR:-/opt/servus} config_dir=${SERVUS_CONFIG_DIR:-/etc/servus} data_dir=${SERVUS_DATA_DIR:-/var/lib/servus}
  local public_url=${SERVUS_PUBLIC_URL:-} bind_address=${SERVUS_BIND_ADDRESS:-127.0.0.1}
  local host_domain_api=${SERVUS_HOST_DOMAINS_API_URL-https://api.servus.run} host_domain_automatic=${SERVUS_HOST_DOMAINS_AUTOMATIC:-true}
  while (( $# )); do
    case "$1" in
      --help|-h) usage; return 0;;
      --dry-run) dry_run=1; shift;;
      --source|--image|--ref|--hostname|--port|--ingress-port|--swarm-advertise-addr)
        (( $# >= 2 )) || fail "Missing value for $1"
        case "$1" in --source) source_dir=$2;; --image) [[ -n $2 ]] || fail 'Image must not be empty.'; image_ref=$2;; --ref) ref=$2; ref_explicit=1;; --hostname) hostname=$2;; --swarm-advertise-addr) [[ -n $2 ]] || fail 'Swarm advertise address must not be empty.'; swarm_advertise_addr=$2;; --port) port=$2;; --ingress-port) ingress_port=$2;; esac
        shift 2;;
      *) fail "Unknown option: $1";;
    esac
  done
  validate_port "$port"; validate_port "$ingress_port"
  validate_host_domain_settings "$host_domain_api" "$host_domain_automatic"
  port=$((10#$port)); ingress_port=$((10#$ingress_port))
  [[ $port != "$ingress_port" ]] || fail 'Panel and application ingress need different ports.'
  validate_ref "$ref"
  if [[ -n $image_ref ]]; then
    validate_image "$image_ref"
    [[ -z $source_dir ]] || fail '--image cannot be combined with --source.'
    (( ref_explicit )) && [[ $ref =~ ^[0-9a-f]{40}$ ]] || fail '--image requires --ref with a full lowercase 40-character Git commit.'
  fi
  for path in "$install_dir" "$config_dir" "$data_dir"; do validate_path "$path"; done
  [[ $install_dir != "$config_dir" && $install_dir != "$data_dir" && $config_dir != "$data_dir" ]] || fail 'Installation, configuration and data directories must differ.'
  local first second
  for first in "$install_dir" "$config_dir" "$data_dir"; do
    for second in "$install_dir" "$config_dir" "$data_dir"; do
      [[ $first == "$second" || $first/ != "$second/"* ]] || fail 'Installation, configuration and data directories must not overlap.'
    done
  done
  [[ $bind_address == 0.0.0.0 || $bind_address == 127.0.0.1 ]] || fail 'Bind address must be 0.0.0.0 or 127.0.0.1.'
  if [[ $bind_address == 0.0.0.0 && ! -f $config_dir/servus.env ]]; then
    fail 'A new installation cannot bind publicly before an administrator exists. Use localhost for setup, then configure public access.'
  fi
  [[ -z $hostname ]] || validate_host "$hostname"
  if [[ -n $swarm_advertise_addr ]]; then
    [[ $swarm_advertise_addr =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Swarm advertise address must be an IPv4 address.'
    validate_host "$swarm_advertise_addr"
    [[ $swarm_advertise_addr != 0.* && $swarm_advertise_addr != 127.* && $swarm_advertise_addr != 255.255.255.255 ]] || fail 'Swarm advertise address must be a usable non-loopback IPv4 address.'
  fi
  if [[ -n $public_url ]]; then
    validate_origin "$public_url"
  fi
  if [[ -n $source_dir ]]; then
    [[ -d $source_dir && -f $source_dir/Dockerfile && -f $source_dir/apps/panel/package.json && -f $source_dir/deployment/compose.yaml ]] || fail 'Source must be a Servus monorepo checkout.'
    source_dir=$(cd "$source_dir" && pwd -P)
  fi
  detect_platform
  if (( dry_run )); then
    printf 'Servus install plan\nOS: %s %s (%s)\nSource: %s\nInstall: %s\nConfig: %s\nData: %s\nPanel port: %s\nApplication ingress port: %s\n' "$os_id" "$os_version" "$architecture" "${source_dir:-https://github.com/raxon/servus/archive/$ref.tar.gz}" "$install_dir" "$config_dir" "$data_dir" "$port" "$ingress_port"
    printf 'Management bind address: %s\n' "$bind_address"
    printf 'New installation host domain API: %s\nAutomatic host registration: %s\n' "${host_domain_api:-disabled}" "$host_domain_automatic"
    if [[ -n $image_ref ]]; then printf 'Image: %s\n' "$image_ref"; fi
    if [[ -n $swarm_advertise_addr ]]; then printf 'Swarm advertise address: %s\n' "$swarm_advertise_addr"; fi
    return 0
  fi
  [[ $(id -u) == 0 ]] || fail 'Run this installer as root, for example with sudo bash.'
  for path in "$install_dir" "$config_dir" "$data_dir"; do check_path_ancestors "$path"; done
  [[ ! -L $config_dir/servus.env && ! -L $install_dir/.servus-install ]] || fail 'Configuration and ownership marker must not be symlinks.'
  if [[ -f $install_dir/.servus-install ]]; then
    [[ $(cat "$install_dir/.servus-install") == servus-installer-v1 ]] || fail 'Unknown installation marker.'
  fi
  if [[ -e $install_dir/current || -L $install_dir/current ]]; then
    [[ -L $install_dir/current ]] || fail 'The current release path must be a Servus-managed symlink.'
    local current_source
    current_source=$(readlink -f "$install_dir/current") || fail 'Cannot resolve the current release.'
    [[ $current_source == "$install_dir/releases/"* && -f $current_source/deployment/compose.yaml ]] || fail 'The current release points outside owned releases or is incomplete.'
  fi
  if [[ -d $install_dir && ! -f $install_dir/.servus-install ]] && [[ -n $(ls -A "$install_dir") ]]; then fail 'Installation directory is not an owned Servus installation.'; fi
  if [[ ! -f $install_dir/.servus-install && -d $config_dir && -n $(ls -A "$config_dir") ]]; then fail 'Configuration directory is not empty and has no Servus installation marker.'; fi
  if [[ ! -f $install_dir/.servus-install && -d $data_dir && -n $(ls -A "$data_dir") ]]; then fail 'Data directory is not empty and has no Servus installation marker.'; fi
  install -d -m 0700 "$install_dir" "$install_dir/releases" "$config_dir"
  command -v flock >/dev/null || fail 'Install util-linux (flock), then retry.'
  exec 9> "$install_dir/install.lock"
  flock -n 9 || fail 'Another Servus installation is running.'
  [[ ! -e $install_dir/.initial-handoff-v1 && ! -L $install_dir/.initial-handoff-v1 ]] || fail 'An interrupted initial handoff requires recovery before installation.'
  [[ ! -e $install_dir/.bootstrap-verification-v1 && ! -L $install_dir/.bootstrap-verification-v1 ]] || fail 'An interrupted bootstrap verification requires recovery before installation.'
  [[ ! -e $install_dir/.legacy-migration-v1 && ! -L $install_dir/.legacy-migration-v1 ]] || fail 'An interrupted legacy migration requires recovery before installation.'
  [[ ! -e $install_dir/.lifecycle-enabled-v1 && ! -L $install_dir/.lifecycle-enabled-v1 ]] || fail 'A supervised installation must be managed through the panel updater.'
  prepare_docker_client
  trap cleanup_staging EXIT
  [[ ! -e $config_dir/servus-origin-migration.pending && ! -L $config_dir/servus-origin-migration.pending ]] || fail 'An unfinished origin migration requires recovery before installation.'
  [[ ! -L $config_dir/servus.env ]] || fail 'Configuration must not be a symlink.'
  if [[ $bind_address == 0.0.0.0 && ! -f $config_dir/servus.env ]]; then
    fail 'A new installation cannot bind publicly before an administrator exists. Use localhost for setup, then configure public access.'
  fi
  if [[ -f $config_dir/servus.env ]]; then
    local preflight_bind
    read_proxy_secret "$config_dir/servus.env"
    read_saved_origins "$config_dir/servus.env"
    preflight_bind=$(awk -F= '$1 == "SERVUS_BIND_ADDRESS" {sub(/^[^=]*=/, ""); print; exit}' "$config_dir/servus.env")
    if [[ $preflight_bind == 0.0.0.0 ]] && ! has_configured_admin "$data_dir"; then
      fail 'Existing public installation has no verifiable administrator. Restrict network access and complete setup before updating. Existing data and bind address were not changed.'
    fi
  fi
  install_dependencies
  local existing_ingress
  existing_ingress=$(trusted_docker service inspect panel-ingress --format '{{index .Spec.Labels "panel.owner"}}' 2>/dev/null || true)
  if [[ -n $existing_ingress && ! -f $install_dir/.servus-install ]]; then fail 'A panel ingress service already exists. Use a fresh Docker host for this installation.'; fi
  [[ -z $existing_ingress || $existing_ingress == self-hosted-panel ]] || fail 'The existing panel-ingress service has a different owner.'
  if [[ ! -f $install_dir/.servus-install && -n $(trusted_docker ps -a --filter label=com.docker.compose.project=servus --format '{{.ID}}') ]]; then fail 'A Compose project named servus already exists. Use a fresh Docker host.'; fi
  printf 'servus-installer-v1\n' > "$install_dir/.servus-install"
  local config_file=$config_dir/servus.env
  if [[ -f $config_file ]]; then
    [[ $(read_setting SERVUS_PORT) == "$port" && $(read_setting SERVUS_INGRESS_PORT) == "$ingress_port" && $(read_setting SERVUS_DATA_DIR) == "$data_dir" ]] || fail 'Existing install uses different ports or data directory. Keep the original arguments when rerunning.'
    public_url=$(read_setting SERVUS_PUBLIC_URL)
    if has_setting SERVUS_HOST_DOMAINS_API_URL; then host_domain_api=$(read_setting SERVUS_HOST_DOMAINS_API_URL); fi
    if [[ -n $(read_setting SERVUS_HOST_DOMAINS_AUTOMATIC) ]]; then host_domain_automatic=$(read_setting SERVUS_HOST_DOMAINS_AUTOMATIC); fi
    validate_host_domain_settings "$host_domain_api" "$host_domain_automatic"
    bind_address=$(read_setting SERVUS_BIND_ADDRESS)
    validate_origin "$public_url"
    [[ $bind_address == 0.0.0.0 || $bind_address == 127.0.0.1 ]] || fail 'Invalid stored bind address.'
    if [[ $bind_address == 0.0.0.0 ]] && ! has_configured_admin "$data_dir"; then
      fail 'Existing public installation has no verifiable administrator. Restrict network access and complete setup before updating. Existing data and bind address were not changed.'
    fi
  fi
  check_port "$port" api; check_port "$ingress_port" ingress
  if [[ -z $hostname ]]; then
    if [[ $bind_address == 127.0.0.1 ]]; then hostname=localhost
    else hostname=$(hostname -I | awk '{for(i=1;i<=NF;i++)if($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/){print $i;exit}}'); fi
  fi
  hostname=${hostname:-127.0.0.1}; validate_host "$hostname"; hostname=${hostname,,}
  local swarm_state
  swarm_state=$(trusted_docker info --format '{{.Swarm.LocalNodeState}}')
  if [[ $swarm_state == inactive ]]; then
    if [[ -n $swarm_advertise_addr ]]; then
      trusted_docker swarm init --advertise-addr "$swarm_advertise_addr" >/dev/null
    else
      trusted_docker swarm init >/dev/null
    fi
  elif [[ $(trusted_docker info --format '{{.Swarm.ControlAvailable}}') != true ]]; then
    fail 'The Docker daemon is already joined to a Swarm as a worker. Use a manager or a fresh VPS.'
  fi
  public_url=${public_url:-http://$hostname:$port}
  public_url=$(normalize_origin "$public_url")
  local secure_cookies=false
  [[ $public_url != https://* ]] || secure_cookies=true
  local allowed_origins=$saved_origins
  append_origin "$public_url"
  append_origin "http://localhost:$port"
  append_origin "http://127.0.0.1:$port"
  local socket_gid release staging image old_env=
  socket_gid=$(stat -c '%g' /var/run/docker.sock)
  release=$(date -u +%Y%m%d%H%M%S)-$$
  staging=$(mktemp -d "$install_dir/.staging.XXXXXXXX")
  servus_staging=$staging
  if [[ -n $image_ref ]]; then
    log "Pulling the pinned image $image_ref."
    trusted_docker pull "$image_ref"
    local image_revision
    image_revision=$(trusted_docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")
    [[ $image_revision == "$ref" ]] || fail 'Image revision label does not match the requested source commit.'
  fi
  install -d -m 0755 "$staging/source"
  if [[ -n $source_dir ]]; then
    COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.data --exclude=artifacts --exclude=design --exclude=.env --exclude='.env.*' --exclude=.turbo -czf "$staging/source.tar.gz" -C "$(dirname "$source_dir")" "$(basename "$source_dir")"
  else
    curl --proto '=https' --tlsv1.2 -fSL "https://github.com/raxon/servus/archive/$ref.tar.gz" -o "$staging/source.tar.gz"
  fi
  extract_source "$staging/source.tar.gz" "$staging/source"
  [[ -f $staging/source/apps/panel/package.json && -f $staging/source/deployment/compose.yaml && -f $staging/source/deployment/compose-supervised.yaml && -f $staging/source/Dockerfile ]] || fail 'Downloaded revision has no Servus monorepo installer. Publish a compatible revision, then retry.'
  mv "$staging/source" "$install_dir/releases/$release"
  local source=$install_dir/releases/$release
  if [[ -z $source_dir && -z $image_ref && $ref_explicit == 0 && $ref == main ]]; then
    [[ -f $source/scripts/signed-bootstrap.sh && ! -L $source/scripts/signed-bootstrap.sh ]] || fail 'The source does not contain the signed installer.'
    source "$source/scripts/signed-bootstrap.sh"
    bootstrap_signed_install "$source" "$staging"
    return
  fi
  if [[ -n $image_ref ]]; then
    image=$image_ref
  else
    image="servus:install-$release"
    log "Building $image from $ref. This can take several minutes."
    trusted_docker build --label io.servus.installer=true -t "$image" "$source"
  fi
  local next_env=$staging/servus.env
  printf 'SERVUS_IMAGE=%s\nSERVUS_DATA_DIR=%s\nSERVUS_PORT=%s\nSERVUS_INGRESS_PORT=%s\nSERVUS_DOCKER_GID=%s\nSERVUS_BIND_ADDRESS=%s\nSERVUS_PUBLIC_URL=%s\nSERVUS_ALLOWED_ORIGINS=%s\nSERVUS_SECURE_COOKIES=%s\nSERVUS_SOURCE_REF=%s\nSERVUS_LIFECYCLE_DIR=%s\nSERVUS_SUPERVISOR_CONTROL_DIR=%s\nSERVUS_SUPERVISOR_SECRET_DIR=%s\n' "$image" "$data_dir" "$port" "$ingress_port" "$socket_gid" "$bind_address" "$public_url" "$allowed_origins" "$secure_cookies" "$ref" "$config_dir/lifecycle" "$config_dir/supervisor-control" "$config_dir/supervisor-secrets" > "$next_env"
  printf 'SERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\n' >> "$next_env"
  printf 'SERVUS_HOST_DOMAINS_API_URL=%s\nSERVUS_HOST_DOMAINS_AUTOMATIC=%s\n' "$host_domain_api" "$host_domain_automatic" >> "$next_env"
  if [[ -n $proxy_secret ]]; then printf 'SERVUS_TRUSTED_PROXY_SECRET=%s\n' "$proxy_secret" >> "$next_env"; fi
  verify_lifecycle_image "$image" "$source/deployment/lifecycle-gate.sh" "$staging"
  local canonical=$staging/compose-canonical.json canonical_check=$staging/compose-canonical-check.json
  verify_lifecycle_compose "$next_env" "$source/deployment/compose-supervised.yaml" "$config_dir/lifecycle" "$image" "$data_dir" "$staging/lifecycle-image-env.json" "$config_dir/supervisor-control" "$config_dir/supervisor-secrets" "$canonical"
  verify_lifecycle_compose "$next_env" "$canonical" "$config_dir/lifecycle" "$image" "$data_dir" "$staging/lifecycle-image-env.json" "$config_dir/supervisor-control" "$config_dir/supervisor-secrets" "$canonical_check"
  cmp -s "$canonical" "$canonical_check" || fail 'The canonical Compose configuration is not stable.'
  prepare_runtime "$source"
  require_supervisor_socket
  if [[ ! -d $data_dir ]]; then install -d -m 0700 -o 1000 -g 1000 "$data_dir"; fi
  [[ $(stat -c '%u' "$data_dir") == 1000 ]] || fail 'The data directory must belong to container UID 1000. Existing ownership was left unchanged.'
  if [[ -f $config_file ]]; then
    old_env=$install_dir/releases/$release-previous.env
    (umask 077; cp "$config_file" "$old_env")
  fi
  local healthy=0
  [[ ! -e $source/deployment/compose.template.yaml && ! -L $source/deployment/compose.template.yaml ]] || fail 'The release contains an unexpected Compose template.'
  python3 -I - "$source/deployment" "$canonical" <<'PYCANONICAL'
import os, sys
directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.rename('compose-supervised.yaml', 'compose.template.yaml', src_dir_fd=directory, dst_dir_fd=directory)
    os.replace(sys.argv[2], 'compose.yaml', dst_dir_fd=directory)
    os.fsync(directory)
finally: os.close(directory)
PYCANONICAL
  servus_config_temp=$(mktemp "$config_dir/.servus.env.XXXXXXXX")
  cp "$next_env" "$servus_config_temp"; chmod 0600 "$servus_config_temp"
  mv -f "$servus_config_temp" "$config_file"; servus_config_temp=
  if trusted_docker compose --env-file "$config_file" -f "$source/deployment/compose.yaml" -p servus up -d --remove-orphans && wait_panel_ready "$port"; then healthy=1; fi
  if (( ! healthy )); then
    if [[ -n $old_env ]]; then
      fail "Manual recovery required: the new panel did not become healthy. The previous image was not started because database compatibility is not verified. Database migrations are not rolled back. Previous configuration: $old_env. Inspect: docker compose --env-file $config_file -f $source/deployment/compose.yaml -p servus logs"
    fi
    fail "Manual recovery required: the new panel did not become healthy. Database migrations are not rolled back. Inspect: docker compose --env-file $config_file -f $source/deployment/compose.yaml -p servus logs"
  fi
  ln -s "$source" "$staging/current"
  mv -Tf "$staging/current" "$install_dir/current"
  print_success "$public_url" "$config_file" "$install_dir" "$bind_address" "$port"
  if [[ $bind_address == 127.0.0.1 ]]; then log 'Management is bound to localhost. Use an SSH tunnel or a local HTTPS reverse proxy for remote access.'; fi
  log 'Configure HTTPS before using the panel across an untrusted network.'
  cleanup_staging; trap - EXIT
}

if [[ ${SERVUS_INSTALLER_LIBRARY:-0} != 1 ]]; then main "$@"; fi

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
servus_staging=

fail() { printf 'Servus: %s\n' "$*" >&2; return 1; }
log() { printf 'Servus: %s\n' "$*"; }
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
  if [[ -n $servus_staging ]]; then rm -rf -- "$servus_staging"; servus_staging=; fi
}
validate_image() { [[ $1 =~ ^ghcr\.io/raxon/servus@sha256:[0-9a-f]{64}$ ]] || fail 'Image must be ghcr.io/raxon/servus with a lowercase sha256 digest.'; }
validate_ref() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$ && $1 != *..* && $1 != */ && $1 != *//* ]] || fail 'Invalid source ref.'; }
validate_origin() {
  [[ $1 =~ ^https?://([a-zA-Z0-9][a-zA-Z0-9.-]*)(:([0-9]{1,5}))?$ ]] || fail 'SERVUS_PUBLIC_URL must be an HTTP(S) origin without a path.'
  local host=${BASH_REMATCH[1]} port=${BASH_REMATCH[3]:-}
  validate_host "$host"
  [[ -z $port ]] || validate_port "$port"
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
install_dependencies() {
  command -v apt-get >/dev/null || fail 'apt-get is required.'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3 iproute2 util-linux
  if ! command -v docker >/dev/null; then
    install -d -m 0755 /etc/apt/keyrings
    curl --proto '=https' --tlsv1.2 -fsSL "https://download.docker.com/linux/$os_id/gpg" -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$os_id" "$os_codename" "$architecture" > /etc/apt/sources.list.d/docker.sources
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  command -v systemctl >/dev/null || fail 'A systemd VPS is required.'
  systemctl enable --now docker
  docker info >/dev/null
  docker compose version >/dev/null || fail 'Docker Compose plugin is missing. Install docker-compose-plugin, then retry.'
  [[ -S /var/run/docker.sock ]] || fail 'The system Docker socket /var/run/docker.sock is required.'
}
check_port() {
  local port=$1 role=$2 listener owned=
  listener=$(ss -H -ltn "sport = :$port")
  [[ -n $listener ]] || return 0
  if [[ -f $install_dir/.servus-install ]]; then
    if [[ $role == api ]]; then
      owned=$(docker ps --filter label=com.docker.compose.project=servus --filter label=com.docker.compose.service=api --filter "publish=$port" --format '{{.ID}}')
    else
      owned=$(docker service inspect panel-ingress --format '{{index .Spec.Labels "panel.owner"}}' 2>/dev/null || true)
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
  local dry_run=0 source_dir= hostname= image_ref= swarm_advertise_addr= ref_explicit=0 ref=${SERVUS_REF:-main} port=4180 ingress_port=80
  local install_dir=${SERVUS_INSTALL_DIR:-/opt/servus} config_dir=${SERVUS_CONFIG_DIR:-/etc/servus} data_dir=${SERVUS_DATA_DIR:-/var/lib/servus}
  local public_url=${SERVUS_PUBLIC_URL:-} bind_address=${SERVUS_BIND_ADDRESS:-127.0.0.1}
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
  if [[ -f $config_dir/servus.env ]]; then
    local preflight_bind
    preflight_bind=$(awk -F= '$1 == "SERVUS_BIND_ADDRESS" {sub(/^[^=]*=/, ""); print; exit}' "$config_dir/servus.env")
    if [[ $preflight_bind == 0.0.0.0 ]] && ! has_configured_admin "$data_dir"; then
      fail 'Existing public installation has no verifiable administrator. Restrict network access and complete setup before updating. Existing data and bind address were not changed.'
    fi
  fi
  install -d -m 0700 "$install_dir" "$install_dir/releases" "$config_dir"
  command -v flock >/dev/null || fail 'Install util-linux (flock), then retry.'
  exec 9> "$install_dir/install.lock"
  flock -n 9 || fail 'Another Servus installation is running.'
  install_dependencies
  local existing_ingress
  existing_ingress=$(docker service inspect panel-ingress --format '{{index .Spec.Labels "panel.owner"}}' 2>/dev/null || true)
  if [[ -n $existing_ingress && ! -f $install_dir/.servus-install ]]; then fail 'A panel ingress service already exists. Use a fresh Docker host for this installation.'; fi
  [[ -z $existing_ingress || $existing_ingress == self-hosted-panel ]] || fail 'The existing panel-ingress service has a different owner.'
  if [[ ! -f $install_dir/.servus-install && -n $(docker ps -a --filter label=com.docker.compose.project=servus --format '{{.ID}}') ]]; then fail 'A Compose project named servus already exists. Use a fresh Docker host.'; fi
  printf 'servus-installer-v1\n' > "$install_dir/.servus-install"
  local config_file=$config_dir/servus.env
  if [[ -f $config_file ]]; then
    [[ $(read_setting SERVUS_PORT) == "$port" && $(read_setting SERVUS_INGRESS_PORT) == "$ingress_port" && $(read_setting SERVUS_DATA_DIR) == "$data_dir" ]] || fail 'Existing install uses different ports or data directory. Keep the original arguments when rerunning.'
    public_url=$(read_setting SERVUS_PUBLIC_URL)
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
  swarm_state=$(docker info --format '{{.Swarm.LocalNodeState}}')
  if [[ $swarm_state == inactive ]]; then
    if [[ -n $swarm_advertise_addr ]]; then
      docker swarm init --advertise-addr "$swarm_advertise_addr" >/dev/null
    else
      docker swarm init >/dev/null
    fi
  elif [[ $(docker info --format '{{.Swarm.ControlAvailable}}') != true ]]; then
    fail 'The Docker daemon is already joined to a Swarm as a worker. Use a manager or a fresh VPS.'
  fi
  public_url=${public_url:-http://$hostname:$port}
  public_url=$(normalize_origin "$public_url")
  local secure_cookies=false
  [[ $public_url != https://* ]] || secure_cookies=true
  local allowed_origins="$public_url,http://localhost:$port,http://127.0.0.1:$port"
  local socket_gid release staging image old_env=
  socket_gid=$(stat -c '%g' /var/run/docker.sock)
  release=$(date -u +%Y%m%d%H%M%S)-$$
  staging=$(mktemp -d "$install_dir/.staging.XXXXXXXX")
  servus_staging=$staging
  trap cleanup_staging EXIT
  if [[ -n $image_ref ]]; then
    log "Pulling the pinned image $image_ref."
    docker pull "$image_ref"
    local image_revision
    image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")
    [[ $image_revision == "$ref" ]] || fail 'Image revision label does not match the requested source commit.'
  fi
  install -d -m 0755 "$staging/source"
  if [[ -n $source_dir ]]; then
    COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.data --exclude=artifacts --exclude=design --exclude=.env --exclude='.env.*' --exclude=.turbo -czf "$staging/source.tar.gz" -C "$(dirname "$source_dir")" "$(basename "$source_dir")"
  else
    curl --proto '=https' --tlsv1.2 -fSL "https://github.com/raxon/servus/archive/$ref.tar.gz" -o "$staging/source.tar.gz"
  fi
  extract_source "$staging/source.tar.gz" "$staging/source"
  [[ -f $staging/source/apps/panel/package.json && -f $staging/source/deployment/compose.yaml && -f $staging/source/Dockerfile ]] || fail 'Downloaded revision has no Servus monorepo installer. Publish a compatible revision, then retry.'
  mv "$staging/source" "$install_dir/releases/$release"
  local source=$install_dir/releases/$release
  if [[ -n $image_ref ]]; then
    image=$image_ref
  else
    image="servus:install-$release"
    log "Building $image from $ref. This can take several minutes."
    docker build --label io.servus.installer=true -t "$image" "$source"
  fi
  if [[ ! -d $data_dir ]]; then install -d -m 0700 -o 1000 -g 1000 "$data_dir"; fi
  [[ $(stat -c '%u' "$data_dir") == 1000 ]] || fail 'The data directory must belong to container UID 1000. Existing ownership was left unchanged.'
  local next_env=$staging/servus.env
  printf 'SERVUS_IMAGE=%s\nSERVUS_DATA_DIR=%s\nSERVUS_PORT=%s\nSERVUS_INGRESS_PORT=%s\nSERVUS_DOCKER_GID=%s\nSERVUS_BIND_ADDRESS=%s\nSERVUS_PUBLIC_URL=%s\nSERVUS_ALLOWED_ORIGINS=%s\nSERVUS_SECURE_COOKIES=%s\nSERVUS_SOURCE_REF=%s\n' "$image" "$data_dir" "$port" "$ingress_port" "$socket_gid" "$bind_address" "$public_url" "$allowed_origins" "$secure_cookies" "$ref" > "$next_env"
  docker compose --env-file "$next_env" -f "$source/deployment/compose.yaml" -p servus config --quiet
  if [[ -f $config_file ]]; then
    old_env=$install_dir/releases/$release-previous.env
    (umask 077; cp "$config_file" "$old_env")
  fi
  local healthy=0
  cp "$next_env" "$config_file"; chmod 0600 "$config_file"
  if docker compose --env-file "$config_file" -f "$source/deployment/compose.yaml" -p servus up -d --remove-orphans && wait_panel_ready "$port"; then healthy=1; fi
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

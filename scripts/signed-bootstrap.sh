#!/usr/bin/env bash
# Integrate a fresh signed release with the protected host updater.
bootstrap_signed_install() {
  local source=$1 staging=$2 candidate parsed tag commit digest operation image next_env
  [[ $install_dir == /opt/servus && $config_dir == /etc/servus ]] || fail 'Signed installation requires the standard host paths.'
  [[ ! -e $config_file && ! -L $config_file ]] || fail 'An existing installation requires a verified migration.'
  [[ ! -e $data_dir || ( -d $data_dir && ! -L $data_dir && -z $(ls -A "$data_dir") ) ]] || fail 'Existing data requires a verified migration.'
  candidate=$staging/release-candidate.json
  /usr/bin/python3 -I "$source/apps/updater/discover-release.py" --initial > "$candidate" || fail 'Cannot discover a release candidate.'
  parsed=$(/usr/bin/python3 -I - "$candidate" <<'PYCANDIDATE'
import json, re, sys, uuid
def unique(pairs):
    out = {}
    for key, value in pairs:
        if key in out: raise ValueError('Duplicate field')
        out[key] = value
    return out
try:
    with open(sys.argv[1], 'rb') as source: data = source.read(16385)
    if len(data) > 16384: raise ValueError('Candidate too large')
    candidate = json.loads(data, object_pairs_hook=unique)
    if (not isinstance(candidate, dict) or set(candidate) != {'status','verified','tag','commit','digest'} or
        candidate['status'] != 'candidate' or candidate['verified'] is not False or
        not isinstance(candidate['tag'], str) or len(candidate['tag']) > 64 or
        not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', candidate['tag']) or
        not isinstance(candidate['commit'], str) or not re.fullmatch(r'[a-f0-9]{40}',candidate['commit']) or
        not isinstance(candidate['digest'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',candidate['digest'])):
        raise ValueError('Invalid candidate')
    if candidate['digest'] == 'sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c':
        raise ValueError('The latest release predates supervised installation')
    print(candidate['tag']); print(candidate['commit']); print(candidate['digest']); print(uuid.uuid4())
except (OSError, ValueError, UnicodeError, RecursionError):
    print('Servus: No compatible signed release candidate is available.', file=sys.stderr)
    sys.exit(1)
PYCANDIDATE
  ) || return 1
  local -a fields
  mapfile -t fields <<< "$parsed"
  [[ ${#fields[@]} == 4 ]] || fail 'Release candidate is invalid.'
  tag=${fields[0]}; commit=${fields[1]}; digest=${fields[2]}; operation=${fields[3]}
  image=ghcr.io/raxon/servus@$digest
  log "Preparing $tag for signed installation."
  /usr/bin/python3 -I "$source/apps/updater/install-host.py" --source "$source" --install-dir "$install_dir" --install-lock-fd 9
  /usr/bin/python3 -I /usr/local/libexec/servus/install-gh.py --install-dir "$install_dir" --install-lock-fd 9
  /usr/bin/python3 -I /usr/local/libexec/servus/provision-host.py
  /usr/bin/python3 -I /usr/local/libexec/servus/provision-host.py --runtime --config-dir "$config_dir" --install-dir "$install_dir" --install-lock-fd 9
  /usr/bin/python3 -I /usr/local/libexec/servus/provision-verifier-group.py --install-lock-fd 9
  if [[ ! -d $data_dir ]]; then install -d -m 0700 -o 1000 -g 1000 "$data_dir"; fi
  [[ ! -L $data_dir && $(stat -c '%u:%g:%a' "$data_dir") == 1000:1000:700 && -z $(ls -A "$data_dir") ]] || fail 'The empty data directory must belong to UID and GID 1000 with mode 0700.'
  next_env=$staging/servus.env
  printf 'SERVUS_IMAGE=%s\nSERVUS_DATA_DIR=%s\nSERVUS_PORT=%s\nSERVUS_INGRESS_PORT=%s\nSERVUS_DOCKER_GID=%s\nSERVUS_BIND_ADDRESS=%s\nSERVUS_PUBLIC_URL=%s\nSERVUS_ALLOWED_ORIGINS=%s\nSERVUS_SECURE_COOKIES=%s\nSERVUS_SOURCE_REF=%s\nSERVUS_LIFECYCLE_DIR=%s\nSERVUS_SUPERVISOR_CONTROL_DIR=%s\nSERVUS_SUPERVISOR_SECRET_DIR=%s\nSERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\n' "$image" "$data_dir" "$port" "$ingress_port" "$socket_gid" "$bind_address" "$public_url" "$allowed_origins" "$secure_cookies" "$tag" "$config_dir/lifecycle" "$config_dir/supervisor-control" "$config_dir/supervisor-secrets" > "$next_env"
  if [[ -n $proxy_secret ]]; then printf 'SERVUS_TRUSTED_PROXY_SECRET=%s\n' "$proxy_secret" >> "$next_env"; fi
  printf 'SERVUS_HOST_DOMAINS_API_URL=%s\nSERVUS_HOST_DOMAINS_AUTOMATIC=%s\n' "$host_domain_api" "$host_domain_automatic" >> "$next_env"
  /usr/bin/python3 -I - "$next_env" "$config_dir" <<'PYCONFIG'
import os, secrets, stat, sys
source, directory = sys.argv[1:]
parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    info = os.fstat(parent)
    if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o700): raise ValueError('Unsafe configuration directory')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_size > 65536: raise ValueError('Unsafe configuration')
        with os.fdopen(fd, 'rb', closefd=False) as stream: data = stream.read(65537)
        if len(data) != info.st_size: raise ValueError('Configuration changed')
    finally: os.close(fd)
    temp = '.servus-env-' + secrets.token_hex(16)
    out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        os.fchown(out, 0, 0); os.fchmod(out, 0o600)
        with os.fdopen(out, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(out)
        os.link(temp, 'servus.env', src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        os.fsync(parent)
    finally:
        os.close(out); os.unlink(temp, dir_fd=parent); os.fsync(parent)
finally: os.close(parent)
PYCONFIG
  log "Verifying the release and starting the panel. Operation: $operation"
  cleanup_staging; trap - EXIT
  exec /usr/bin/python3 -I /usr/local/libexec/servus/bootstrap-initial.py --operation "$operation" --commit "$commit" --digest "$digest" --tag "$tag" --take-install-lock-fd 9
}

#!/bin/sh
# Install a panel-only fallback on the existing IP TLS proxy.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Linux root is required.' >&2; exit 1; }
source_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install -d -m 0755 /var/lib/servus-maintenance /etc/servus-maintenance
install -m 0644 "$source_root/deployment/maintenance/maintenance.html" /var/lib/servus-maintenance/maintenance.html
install -m 0644 "$source_root/deployment/maintenance/locations.conf" /etc/servus-maintenance/locations.conf
python3 - <<'PY'
from pathlib import Path
import os
import subprocess
import tempfile
p = Path('/etc/servus-ip-tls/nginx.conf')
original = p.read_bytes()
text = original.decode()
if 'include /etc/servus-maintenance/locations.conf;' not in text:
    needle = '    location / {'
    if text.count(needle) != 1:
        raise SystemExit('Unexpected TLS proxy configuration')
    text = text.replace(needle, '    include /etc/servus-maintenance/locations.conf;\n' + needle + '\n      proxy_intercept_errors on;\n      error_page 502 503 504 /__servus-maintenance;')
    backup = p.with_name('nginx.conf.before-maintenance-page')
    if not backup.exists():
        with backup.open('xb') as f:
            os.chmod(backup, 0o600)
            f.write(original)
    def write(value):
        fd, name = tempfile.mkstemp(dir=p.parent, prefix='.maintenance-')
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(value)
                f.flush()
                os.fsync(f.fileno())
                os.fchmod(f.fileno(), 0o644)
            os.replace(name, p)
        finally:
            if os.path.exists(name): os.unlink(name)
    write(text.encode())
    if subprocess.run(['/usr/sbin/nginx', '-t', '-c', str(p)]).returncode:
        write(original)
        raise SystemExit('TLS proxy validation failed; configuration restored')
PY
systemctl reload servus-ip-tls-proxy.service

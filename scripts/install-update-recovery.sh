#!/bin/sh
# Install the independent pre-switch recovery watchdog from this checkout.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Linux root is required.' >&2; exit 1; }
source_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=/usr/local/libexec/servus-recovery
install -d -m 0700 "$target"
for name in recover-pre-switch.py reconcile-policy-journal.py reconcile-policy-fence.py supervisor.py; do
  install -m 0600 "$source_root/apps/updater/$name" "$target/$name"
done
for name in servus-update-recovery.service servus-update-recovery.timer; do
  install -m 0644 "$source_root/deployment/$name" "/etc/systemd/system/$name"
done
systemctl daemon-reload
systemctl enable --now servus-update-recovery.timer

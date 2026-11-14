#!/bin/sh
# Start Node only while the host-owned lifecycle gate permits it.
set -eu
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
gate=/run/servus-lifecycle

fail() { printf '%s\n' 'Servus lifecycle gate rejected startup.' >&2; exit 1; }

# The host coordinator is trusted and must own this read-only bind mount. It
# must never replace the lock inode; the state file may be replaced atomically.
[ ! -L /run ] && [ "$(/usr/bin/stat -c '%u:%g:%a:%F' /run)" = '0:0:755:directory' ] || fail
[ ! -L "$gate" ] && [ "$(/usr/bin/stat -c '%u:%g:%a:%F' "$gate" 2>/dev/null)" = '0:0:755:directory' ] || fail
mount_options=$(/usr/bin/findmnt -rn -o OPTIONS --mountpoint "$gate") || fail
case ",$mount_options," in *,ro,*) ;; *) fail ;; esac

lock=$gate/lock
state=$gate/state
[ -f "$lock" ] && [ ! -L "$lock" ] && [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$lock" 2>/dev/null)" = '0:0:644:1' ] || fail
exec 9<"$lock" || fail
check_lock_identity() {
  [ ! -L "$lock" ] || fail
  opened=$(/usr/bin/stat -L -c '%u:%g:%a:%h:%F:%d:%i' /proc/self/fd/9) || fail
  current=$(/usr/bin/stat -c '%u:%g:%a:%h:%F:%d:%i' "$lock" 2>/dev/null) || fail
  [ "$opened" = "$current" ] || fail
  [ "$(/usr/bin/stat -L -c '%u:%g:%a:%h' /proc/self/fd/9)" = '0:0:644:1' ] || fail
}
check_lock_identity
/usr/bin/flock -s -n 9 || fail
check_lock_identity

# The shared lock stays on fd 9 across exec. A coordinator must hold the
# exclusive lock before resetting the state to normal after maintenance.
[ -f "$state" ] && [ ! -L "$state" ] && [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$state" 2>/dev/null)" = '0:0:644:1' ] || fail
printf 'servus-lifecycle-v1 normal\n' | /usr/bin/cmp -s - "$state" || fail
[ "$#" -gt 0 ] || fail
exec /usr/local/bin/node "$@"

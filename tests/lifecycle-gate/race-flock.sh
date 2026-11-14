#!/bin/sh
# Test-only synchronization around the real flock binary.
set -eu
: > /tmp/servus-flock-ready
while [ ! -e /tmp/servus-flock-continue ]; do sleep 0.05; done
exec /run/servus-lifecycle/flock-real "$@"

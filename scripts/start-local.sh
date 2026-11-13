#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v colima >/dev/null 2>&1; then
  colima start panel-dev --cpu 2 --memory 4 --disk 25 --activate=false --mount "$(pwd):w"
fi
npm run build
exec node scripts/local.mjs

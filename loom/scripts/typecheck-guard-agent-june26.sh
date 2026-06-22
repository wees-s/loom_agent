#!/usr/bin/env bash
set -euo pipefail

cd ~/WORKSPACE/loom
echo "=== pnpm --filter @loom/engine typecheck ==="
pnpm --filter @loom/engine typecheck 2>&1 || true
echo "=== DONE ==="

#!/usr/bin/env bash
# Dev launcher (WSL): strips CRLF on self, then runs engine + vite together.
# Engine uses node:sqlite via --experimental-sqlite (wired into the engine "dev" script).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# self-heal CRLF if this file was touched on the Windows side
sed -i 's/\r$//' "$ROOT/scripts/dev.sh" 2>/dev/null || true

exec pnpm dev

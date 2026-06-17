#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/Users/scarecrow/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi

cd "$ROOT"
exec "$NODE_BIN" server/index.mjs

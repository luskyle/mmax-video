#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1 || [[ ! -f "$root/node_modules/electron/cli.js" ]]; then
  echo "缺少系统 Node.js 或 Electron 依赖，请参阅 README.md 的安装说明。" >&2
  exit 1
fi
cd "$root"
exec node "$root/node_modules/electron/cli.js" .

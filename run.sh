#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
local_node="$root/.tools/node-v22.23.5-linux-x64/bin"
if [[ -x "$local_node/node" ]]; then
  export PATH="$local_node:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || [[ ! -x "$root/node_modules/.bin/electron" ]]; then
  echo "缺少 Node.js 或 Electron 依赖，请参阅 README.md 的安装说明。" >&2
  exit 1
fi
cd "$root"
exec "$root/node_modules/.bin/electron" .

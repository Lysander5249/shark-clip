#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node.js 22 或更新版本，请先安装 Node.js。"
  read -k 1
  exit 1
fi
exec node server.mjs --open

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/harness"
node scripts/typecheck.mjs
node scripts/build.mjs
node scripts/prepare-python.mjs
echo '构建和 Python 安装准备完成；请安装到现有 DSH，并在实际安装位置准备环境后启用。'

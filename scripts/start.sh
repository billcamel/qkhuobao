#!/usr/bin/env bash
# 火宝短剧 — 本地工作台启动脚本（单服务模式：后端同时托管前端静态站）
#
# 用法：
#   scripts/start.sh          启动（默认端口 5679）
#   scripts/start.sh 6000     指定端口
#   scripts/start.sh --dev    前后端分离热重载模式（前端 3013 + 后端 5679）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${1:-5679}"
MODE="${2:-single}"

if [[ ! -d backend/node_modules ]]; then
  echo "✗ backend 依赖未安装，先跑：cd backend && npm install"
  exit 1
fi

if [[ "$MODE" == "--dev" ]]; then
  echo "▶ 开发模式：前端 http://localhost:3013  后端 http://localhost:5679"
  (cd frontend && npm run dev) &
  FE_PID=$!
  (cd backend && npm run dev) &
  BE_PID=$!
  trap 'kill $FE_PID $BE_PID 2>/dev/null || true' EXIT INT TERM
  wait
  exit 0
fi

# 单服务模式：前端产物必须已生成
if [[ ! -f frontend/dist/index.html ]]; then
  echo "→ 未发现 frontend/dist，先构建前端…"
  (cd frontend && npm run generate && rm -rf dist && cp -r .output/public dist)
fi

echo "▶ 启动火宝短剧：http://localhost:${PORT}"
echo "  数据目录：${ROOT}/data"
echo "  停止：Ctrl+C"
cd "${ROOT}/backend"
exec env PORT="${PORT}" npm start

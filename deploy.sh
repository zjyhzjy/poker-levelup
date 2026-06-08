#!/usr/bin/env bash
# 日常更新：拉最新代码 + 只重启游戏服务。
# 隧道不动，所以公网网址保持不变。隧道若意外掉线会自动重启（此时网址才会变）。
set -euo pipefail
cd "$(dirname "$0")"

CLOUDFLARED="$HOME/.local/bin/cloudflared"
PORT=3000
RUN_DIR=".run"
SERVER_LOG="$RUN_DIR/server.log"
TUNNEL_LOG="$RUN_DIR/tunnel.log"
mkdir -p "$RUN_DIR"

echo "→ 拉取最新代码..."
git pull origin main

echo "→ 重启游戏服务（只重启服务，不动隧道）..."
pkill -f "node server.js" 2>/dev/null || true
sleep 1
: > "$SERVER_LOG"
nohup node server.js > "$SERVER_LOG" 2>&1 &
disown 2>/dev/null || true
for _ in $(seq 1 20); do
  grep -q "running at" "$SERVER_LOG" 2>/dev/null && break
  sleep 0.5
done
echo "✓ 服务已用新代码重启"

# 隧道若不在运行则重启（此时网址会变）
if ! pgrep -f "cloudflared tunnel --url" >/dev/null; then
  echo "⚠ 隧道不在运行，重新启动（网址会变化）..."
  : > "$TUNNEL_LOG"
  nohup "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 30); do
    grep -qE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null && break
    sleep 1
  done
fi

URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
echo
echo "================================================================"
echo "  已更新部署 ✓   公网网址: ${URL:-<查看 $TUNNEL_LOG>}"
echo "================================================================"

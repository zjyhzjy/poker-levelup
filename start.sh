#!/usr/bin/env bash
# 首次开机：启动游戏服务 + Cloudflare 隧道，打印公网网址。
# 之后日常更新代码请用 ./deploy.sh（网址保持不变）。
set -euo pipefail
cd "$(dirname "$0")"

CLOUDFLARED="${CLOUDFLARED:-}"
if [ -z "$CLOUDFLARED" ]; then
  if [ -x "$HOME/.local/bin/cloudflared" ]; then
    CLOUDFLARED="$HOME/.local/bin/cloudflared"
  else
    CLOUDFLARED="$(command -v cloudflared || true)"
  fi
fi
PORT=3000
RUN_DIR=".run"
SERVER_LOG="$RUN_DIR/server.log"
TUNNEL_LOG="$RUN_DIR/tunnel.log"
mkdir -p "$RUN_DIR"

# --- 游戏服务 ---
if pgrep -f "node server.js" >/dev/null; then
  echo "✓ 游戏服务已在运行"
else
  echo "→ 启动游戏服务..."
  : > "$SERVER_LOG"
  nohup node server.js > "$SERVER_LOG" 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 20); do
    grep -q "running at" "$SERVER_LOG" 2>/dev/null && break
    sleep 0.5
  done
  echo "✓ 游戏服务已启动 (http://localhost:$PORT)"
fi

# --- Cloudflare 隧道 ---
if [ -z "$CLOUDFLARED" ] || [ ! -x "$CLOUDFLARED" ]; then
  echo "✗ 未找到 cloudflared。Mac 可运行: brew install cloudflared"
  exit 1
fi

if pgrep -f "cloudflared tunnel --url" >/dev/null; then
  echo "✓ 隧道已在运行"
else
  echo "→ 启动 Cloudflare 隧道..."
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
echo "  公网网址: ${URL:-<还没生成，稍后查看 $TUNNEL_LOG>}"
echo "================================================================"

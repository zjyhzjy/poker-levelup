#!/usr/bin/env bash
# 查看当前部署状态：服务、隧道、网址、可访问性。
set -uo pipefail
cd "$(dirname "$0")"

PORT=3000
TUNNEL_LOG=".run/tunnel.log"

echo "================ 部署状态 ================"

# --- 游戏服务 ---
SRV_PID=$(pgrep -f "node server.js" | head -1 || true)
if [ -n "$SRV_PID" ]; then
  echo "游戏服务 : ✅ 运行中 (PID $SRV_PID)"
else
  echo "游戏服务 : ❌ 未运行   → 跑 ./start.sh"
fi

# --- 隧道 ---
TUN_PID=$(pgrep -f "cloudflared tunnel --url" | head -1 || true)
if [ -n "$TUN_PID" ]; then
  echo "隧  道   : ✅ 运行中 (PID $TUN_PID)"
else
  echo "隧  道   : ❌ 未运行   → 跑 ./start.sh"
fi

# --- 网址 ---
URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
echo "公网网址 : ${URL:-（无，隧道未运行）}"

# --- 可访问性 ---
if [ -n "$SRV_PID" ]; then
  LOCAL=$(curl -s -o /dev/null -m 3 -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null || echo "000")
  echo "本地访问 : $([ "$LOCAL" = "200" ] && echo "✅ HTTP 200" || echo "⚠️ HTTP $LOCAL")"
fi
if [ -n "${URL:-}" ]; then
  PUB=$(curl -s -o /dev/null -m 6 -w "%{http_code}" "$URL/" 2>/dev/null || echo "000")
  echo "公网访问 : $([ "$PUB" = "200" ] && echo "✅ HTTP 200" || echo "⚠️ HTTP $PUB")"
fi

echo "=========================================="

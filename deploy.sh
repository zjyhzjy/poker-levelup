#!/usr/bin/env bash
# 日常更新：拉最新代码 + 只重启游戏服务。
# 隧道不动，所以公网网址保持不变。隧道若意外掉线会自动重启。
#
# 隧道模式与 start.sh 一致：
#  - 默认（临时隧道）：随机 trycloudflare.com 网址，重启隧道时会变。
#  - 固定域名（命名隧道）：设置 TUNNEL_NAME 和 TUNNEL_HOSTNAME，网址稳定不变。
#    例如：TUNNEL_NAME=poker TUNNEL_HOSTNAME=poker.zifanzhang.com ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

# 解析 cloudflared：优先 $CLOUDFLARED，再 ~/.local/bin，最后 PATH。
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
TUNNEL_NAME="${TUNNEL_NAME:-}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}"
mkdir -p "$RUN_DIR"

# 先安全拉取：只允许快进。一旦分叉就中止，且此时还没动服务，旧版本继续运行（不停机）。
echo "→ 拉取最新代码..."
if ! git pull --ff-only origin main; then
  echo "✋ 本地与远程已分叉，部署中止（未重启服务，旧版本仍在运行）。"
  exit 1
fi

echo "→ 重启游戏服务（只重启服务，不动隧道）..."
pkill -f "node server.js" 2>/dev/null || true
sleep 1
: > "$SERVER_LOG"
nohup node server.js > "$SERVER_LOG" 2>&1 &
disown 2>/dev/null || true
started=0
for _ in $(seq 1 20); do
  if grep -q "running at" "$SERVER_LOG" 2>/dev/null; then
    started=1
    break
  fi
  sleep 0.5
done
if [ "$started" != "1" ]; then
  echo "✗ 服务重启失败（10 秒内未就绪）。最近日志："
  tail -n 20 "$SERVER_LOG" 2>/dev/null || true
  exit 1
fi
echo "✓ 服务已用新代码重启"

# 隧道若不在运行则重启
if [ -n "$TUNNEL_NAME" ]; then
  # 命名隧道：稳定域名，网址不变。
  if ! pgrep -f "cloudflared tunnel .*run" >/dev/null; then
    echo "⚠ 命名隧道不在运行，重新启动 ($TUNNEL_NAME)..."
    if [ -z "$CLOUDFLARED" ] || [ ! -x "$CLOUDFLARED" ]; then
      echo "⚠ 未找到 cloudflared，跳过隧道重启（服务已重启成功）。可用 brew install cloudflared 后再跑 ./start.sh"
    else
      : > "$TUNNEL_LOG"
      nohup "$CLOUDFLARED" tunnel run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
      disown 2>/dev/null || true
    fi
  fi
  URL="https://${TUNNEL_HOSTNAME:-<请设置 TUNNEL_HOSTNAME>}"
else
  # 临时隧道：随机 trycloudflare.com 网址，重启时会变。
  if ! pgrep -f "cloudflared tunnel --url" >/dev/null; then
    echo "⚠ 隧道不在运行，重新启动（网址会变化）..."
    if [ -z "$CLOUDFLARED" ] || [ ! -x "$CLOUDFLARED" ]; then
      echo "⚠ 未找到 cloudflared，跳过隧道重启（服务已重启成功）。可用 brew install cloudflared 后再跑 ./start.sh"
    else
      : > "$TUNNEL_LOG"
      nohup "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
      disown 2>/dev/null || true
      for _ in $(seq 1 30); do
        grep -qE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null && break
        sleep 1
      done
    fi
  fi
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  URL="${URL:-<查看 $TUNNEL_LOG>}"
fi

echo
echo "================================================================"
echo "  已更新部署 ✓   公网网址: $URL"
echo "================================================================"

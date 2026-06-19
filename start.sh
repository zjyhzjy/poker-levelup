#!/usr/bin/env bash
# 首次开机：启动游戏服务 + Cloudflare 隧道，打印公网网址。
# 之后日常更新代码请用 ./deploy.sh（网址保持不变）。
#
# 两种隧道模式：
#  - 默认（临时隧道）：不设任何环境变量，得到一个随机的 trycloudflare.com 网址，
#    每次重启都会变。适合临时分享。
#  - 固定域名（命名隧道）：设置 TUNNEL_NAME 和 TUNNEL_HOSTNAME，得到一个稳定网址，
#    例如：TUNNEL_NAME=poker TUNNEL_HOSTNAME=poker.zifanzhang.com ./start.sh
#    详见 docs/deploy-domain.md。
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

# --- 游戏服务 ---
if pgrep -f "node server.js" >/dev/null; then
  echo "✓ 游戏服务已在运行"
else
  echo "→ 启动游戏服务..."
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
    echo "✗ 游戏服务启动失败（10 秒内未就绪）。最近日志："
    tail -n 20 "$SERVER_LOG" 2>/dev/null || true
    exit 1
  fi
  echo "✓ 游戏服务已启动 (http://localhost:$PORT)"
fi

# --- Cloudflare 隧道 ---
if [ -z "$CLOUDFLARED" ] || [ ! -x "$CLOUDFLARED" ]; then
  echo "✗ 未找到 cloudflared。Mac 可运行: brew install cloudflared"
  exit 1
fi

if [ -n "$TUNNEL_NAME" ]; then
  # 命名隧道：稳定域名，网址不变（无需从日志里抓 trycloudflare 网址）。
  if pgrep -f "cloudflared tunnel .*run" >/dev/null; then
    echo "✓ 命名隧道已在运行 ($TUNNEL_NAME)"
  else
    echo "→ 启动命名隧道 ($TUNNEL_NAME)..."
    : > "$TUNNEL_LOG"
    nohup "$CLOUDFLARED" tunnel run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
    disown 2>/dev/null || true
  fi
  URL="https://${TUNNEL_HOSTNAME:-<请设置 TUNNEL_HOSTNAME>}"
else
  # 临时隧道：随机 trycloudflare.com 网址，每次重启会变。
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
  URL="${URL:-<还没生成，稍后查看 $TUNNEL_LOG>}"
fi

echo
echo "================================================================"
echo "  公网网址: $URL"
echo "================================================================"

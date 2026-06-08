#!/usr/bin/env bash
# 停掉游戏服务和隧道。
set -euo pipefail
cd "$(dirname "$0")"

pkill -f "node server.js" 2>/dev/null && echo "✓ 已停止游戏服务" || echo "· 游戏服务未在运行"
pkill -f "cloudflared tunnel --url" 2>/dev/null && echo "✓ 已停止隧道" || echo "· 隧道未在运行"

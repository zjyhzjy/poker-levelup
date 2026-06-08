#!/usr/bin/env bash
# 只拉取最新代码，绝不覆盖本地未提交的修改。
#
# 安全机制：
#  - 用 --ff-only：只允许“快进”，一旦本地和远程分叉（双方都有新提交）就停下并报错，
#    不会自动合并、也不会动你的本地提交，让你自己决定怎么处理。
#  - 拉之前若发现有未提交的改动会先提醒你（git 本身也会拒绝覆盖它们）。
set -euo pipefail
cd "$(dirname "$0")"

# 有未提交的本地改动就先提醒（含已暂存/未暂存/未跟踪）
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  本地有未提交的改动（git 不会覆盖它们）："
  git status --short
  echo
fi

echo "→ git pull --ff-only origin main"
if git pull --ff-only origin main; then
  echo "✓ 已拉到最新（快进）"
else
  echo
  echo "✋ 本地与远程已分叉，pull 已安全中止，没有改动任何文件。"
  echo "   说明两边都各自有新提交。需要合并时再叫我，或手动处理。"
  exit 1
fi

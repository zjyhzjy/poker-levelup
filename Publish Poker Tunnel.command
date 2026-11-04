#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

trap 'echo "发布未完成。请把错误信息发给维护者，勿发送凭据或口令。"' ERR

if ! command -v age >/dev/null; then
  if ! command -v brew >/dev/null; then
    echo "找不到 Homebrew。请让维护者先安装 age。"
    exit 1
  fi
  brew install age
fi

if ! command -v expect >/dev/null; then
  echo "找不到 expect。请让维护者检查这台 Mac 的终端环境。"
  exit 1
fi

credential=$(node --input-type=module -e '
  import { existsSync, readFileSync } from "node:fs";
  import { homedir } from "node:os";
  import { isAbsolute, join } from "node:path";
  const dir = join(homedir(), ".cloudflared");
  for (const name of ["config.yml", "config.yaml"]) {
    const config = join(dir, name);
    if (!existsSync(config)) continue;
    const yaml = readFileSync(config, "utf8");
    if (!/^\s*-?\s*hostname:\s*["\x27]?poker\.zifanzhang\.com["\x27]?(?:\s+#.*)?[ \t]*$/m.test(yaml)) continue;
    const field = yaml.match(/^credentials-file:[ \t]*("[^"]+"|\x27[^\x27]+\x27|[^\r\n#]+?)[ \t]*(?:#.*)?\r?$/m)?.[1];
    const path = field?.trim().replace(/^["\x27]|["\x27]$/g, "").replace(/^~\//, homedir() + "/");
    if (!path || !isAbsolute(path) || !existsSync(path)) continue;
    console.log(path);
    process.exit(0);
  }
  console.error("找不到 poker.zifanzhang.com 的隧道凭据。请维护者检查 ~/.cloudflared/config.yml。");
  process.exit(1);
')

POKER_AUTO_PASSPHRASE=1 bash ./tunnel-handoff.sh publish "$credential"
echo "发布成功。请只把上面显示的随机口令私下发给开服者。"

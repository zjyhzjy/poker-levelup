#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077

hostname=poker.zifanzhang.com
bundle=poker-tunnel.json.age

fail() { echo "$*" >&2; exit 1; }

tunnel_id() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try {
      const { AccountTag, TunnelID, TunnelSecret } = JSON.parse(readFileSync(process.argv[1], "utf8"));
      if (!/^[a-f0-9]{32}$/i.test(AccountTag) ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(TunnelID) ||
          typeof TunnelSecret !== "string" || !TunnelSecret) throw new Error();
      console.log(TunnelID);
    } catch {
      console.error("需要 cloudflared 创建的隧道凭据 JSON 文件。");
      process.exit(1);
    }
  ' "$1"
}

case "${1:-}" in
  publish)
    [ "$#" -eq 2 ] || fail "用法：bash tunnel-handoff.sh publish <隧道凭据.json>"
    command -v age >/dev/null || fail "请先安装 age（Mac: brew install age）。"
    tunnel_id "$2" >/dev/null
    [ "$(git branch --show-current)" = main ] || fail "请在 main 分支运行。"
    [ -z "$(git status --porcelain)" ] || fail "请先处理工作区内未提交的文件。"
    git fetch origin main
    [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ] || fail "请先将本地 main 与 origin/main 同步。"
    mkdir -p .run
    tmp=$(mktemp -d .run/tunnel-publish.XXXXXX)
    trap 'rm -f -- "$tmp/bundle"; rmdir -- "$tmp"' EXIT
    if [ "${POKER_AUTO_PASSPHRASE:-0}" = 1 ]; then
      POKER_AGE_OUTPUT="$tmp/bundle" POKER_AGE_INPUT="$2" expect <<'EXPECT'
set timeout 60
spawn age --passphrase --armor -o $env(POKER_AGE_OUTPUT) -- $env(POKER_AGE_INPUT)
expect {
  -glob "*Enter passphrase*" { send -- "\r" }
  timeout { exit 1 }
  eof { exit 1 }
}
expect {
  eof {}
  timeout { exit 1 }
}
exit [lindex [wait] 3]
EXPECT
    else
      echo "在 age 的口令提示处直接回车，让它生成强口令。记下口令并私下分享。"
      age --passphrase --armor -o "$tmp/bundle" -- "$2"
    fi
    [ -s "$tmp/bundle" ] &&
      [ "$(head -n 1 "$tmp/bundle")" = "-----BEGIN AGE ENCRYPTED FILE-----" ] &&
      [ "$(tail -n 1 "$tmp/bundle")" = "-----END AGE ENCRYPTED FILE-----" ] ||
      fail "未生成完整的加密文件，已取消上传。"
    mv -- "$tmp/bundle" "$bundle"
    git add -- "$bundle"
    git commit --only -m "Publish encrypted poker tunnel credentials" -- "$bundle"
    git push origin HEAD:main
    ;;
  start)
    [ "$#" -eq 1 ] || fail "用法：bash tunnel-handoff.sh start"
    command -v age >/dev/null || fail "请先安装 age（Mac: brew install age）。"
    [ -f "$bundle" ] || fail "找不到 $bundle。请让 A 发布后再 git pull。"
    mkdir -p .run
    tmp=$(mktemp -d .run/tunnel-import.XXXXXX)
    trap 'rm -f -- "$tmp/credentials.json"; rmdir -- "$tmp"' EXIT
    age --decrypt -o "$tmp/credentials.json" "$bundle"
    id=$(tunnel_id "$tmp/credentials.json")
    mv -- "$tmp/credentials.json" .run/poker-tunnel.json
    node --input-type=module -e '
      import { resolve } from "node:path";
      import { writeFileSync } from "node:fs";
      const [id, hostname] = process.argv.slice(1);
      const credentials = JSON.stringify(resolve(".run/poker-tunnel.json"));
      const config = [
        `tunnel: ${id}`,
        `credentials-file: ${credentials}`,
        "ingress:",
        `  - hostname: ${hostname}`,
        "    service: http://localhost:3000",
        "  - service: http_status:404",
        ""
      ].join("\n");
      writeFileSync(".run/poker-tunnel.yml", config, { mode: 0o600 });
    ' "$id" "$hostname"
    TUNNEL_CONFIG=".run/poker-tunnel.yml" TUNNEL_NAME="$id" TUNNEL_HOSTNAME="$hostname" bash ./start.sh
    ;;
  *) fail "用法：bash tunnel-handoff.sh publish <隧道凭据.json> 或 bash tunnel-handoff.sh start" ;;
esac

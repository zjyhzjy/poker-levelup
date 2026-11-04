# 固定域名开服交接

游戏网址是 [poker.zifanzhang.com](https://poker.zifanzhang.com)，项目是
[zjyhzjy/poker-levelup](https://github.com/zjyhzjy/poker-levelup)。A 发布一次加密隧道凭据，
B、C 就能轮流在自己的电脑上开服。普通玩家只需要游戏网址。

## A 只做一次

1. 在原来用来开服的 Mac 上，打开包含最新代码的游戏项目文件夹。
2. 双击 **Publish Poker Tunnel.command**。如果 GitHub 弹出登录提示，按提示登录。
3. 等窗口显示「发布成功」。把窗口里生成的随机口令私下发给 B、C。

脚本会从 `~/.cloudflared/config.yml` 或 `config.yaml` 找到固定域名对应的凭据，
必要时用 Homebrew 安装 `age`，然后生成强口令，把加密文件
`poker-tunnel.json.age` 推到 GitHub。A 原来的域名和 DNS 路由继续使用。
如果 A 正在开服，先等牌局结束，再运行 `bash stop.sh` 让出隧道。

### 给 A 的 Codex / Claude

> 请在 A 原来开服的 Mac 上准备固定域名交接。项目为
> `zjyhzjy/poker-levelup`，目标域名为 `poker.zifanzhang.com`。
> 用 `git status --short`、`git branch --show-current` 和 `git remote -v`
> 检查工作区干净、分支为 `main`、远程为该项目。使用
> `git pull --ff-only` 同步代码。如果有本地改动或分支分叉，请先保留现场并告诉我。
> 确认项目包含 `Publish Poker Tunnel.command` 和 `tunnel-handoff.sh`，
> 确认 Node.js、GitHub 写权限，以及本地 Cloudflare 配置里的域名与凭据路径可用。
> 检查配置时只报告是否匹配，不读取或输出凭据 JSON 的内容。
> 准备完成后，让我在 Finder 里双击发布文件。生成的口令应留在我自己的终端窗口，
> 不要让它进入 agent 工具输出或聊天。发布后，用
> `git fetch origin main` 和 `git cat-file -e origin/main:poker-tunnel.json.age`
> 确认加密文件已在 GitHub。提醒我私下把口令发给 B、C。
> 如果提交已生成但推送失败，修复 GitHub 登录或权限后重试 `git push origin main`，
> 沿用原口令，避免重新发布。

## B、C 每次开服

1. 确认上一位开服者已经停服。安装 Node.js、`cloudflared` 和 `age`。
   Mac 可以用 `brew install cloudflared age`。在支持项目 Bash 脚本的环境中运行以下命令。
2. 打开项目文件夹，在终端运行：

   ```bash
   git pull --ff-only
   bash tunnel-handoff.sh start
   ```

3. 在终端提示时输入 A 私下发来的口令。打开
   [poker.zifanzhang.com](https://poker.zifanzhang.com)，确认可以进房。
4. 打完后运行 `bash stop.sh`，再让下一位接手。进行中的牌局不会随主机迁移。

### 给 B / C 的 Codex / Claude

> 请帮我在本机用 `poker.zifanzhang.com` 开服。项目为
> `zjyhzjy/poker-levelup`。请检查 Node.js、`cloudflared`、`age` 和 Bash，
> 检查 Git 状态并用 `git pull --ff-only` 同步代码，确认存在
> `poker-tunnel.json.age`。若缺少加密文件，告诉我先请 A 完成发布。
> 确认上一台主机已经停服后，让我在自己的终端运行
> `bash tunnel-handoff.sh start` 并亲自输入解密口令。请勿索取或记录口令，
> 也不要读取本机生成的 `.run/poker-tunnel.json`。
> 启动后先检查 `http://localhost:3000`，再检查固定域名能否打开游戏并进房。
> 如果固定域名打不开，可以查看 `.run/tunnel.log` 诊断连接问题，
> 分享日志前请剔除任何凭据。停服时使用 `bash stop.sh`。

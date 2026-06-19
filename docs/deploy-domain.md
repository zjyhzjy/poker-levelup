# 用固定域名发布（升级找朋友）

默认的 `./start.sh` 用的是 Cloudflare **临时隧道**：会给一个随机的
`https://<随机>.trycloudflare.com` 网址，**每次重启都会变**，只适合临时分享。

想要一个**永不变**的网址（例如 `poker.zifanzhang.com`），有两个方案。

---

## 方案 A：Cloudflare 命名隧道 + 子域名（推荐）

- 免费、稳定网址；
- 服务仍然跑在你自己的 Mac 上（“在你电脑上运行”这一点不变）；
- 域名注册商仍留在 Namecheap，只是把 DNS 解析交给 Cloudflare 托管。

> 前提：你已拥有域名 `zifanzhang.com`（在 Namecheap，目前用的是 “Namecheap BasicDNS”）。

### 步骤

1. **安装 cloudflared**（Mac）：

   ```bash
   brew install cloudflared
   ```

2. **登录 Cloudflare**（会打开浏览器，把域名 `zifanzhang.com` 加入你的 Cloudflare 账户并授权）：

   ```bash
   cloudflared tunnel login
   ```

3. **创建命名隧道**（这里取名 `poker`）：

   ```bash
   cloudflared tunnel create poker
   ```

   命令会打印出**隧道 UUID**和一个**凭据文件路径**（形如
   `~/.cloudflared/<UUID>.json`），记下来。

4. **写配置文件**：把模板复制过去并填上面记下的值：

   ```bash
   cp cloudflared.config.example.yml ~/.cloudflared/config.yml
   ```

   编辑 `~/.cloudflared/config.yml`，把 `tunnel:`（UUID）、`credentials-file:`（凭据文件路径）、
   `hostname:`（`poker.zifanzhang.com`）填好；`service:` 保持 `http://localhost:3000`。

5. **加 DNS 路由**（让 Cloudflare 把子域名指向这个隧道）：

   ```bash
   cloudflared tunnel route dns poker poker.zifanzhang.com
   ```

6. **Namecheap 改 Nameserver**（关键的一步）：
   - 在 Cloudflare 把 `zifanzhang.com` 添加为一个 zone 时，Cloudflare 会分配**两个专属的
     Nameserver**（形如 `xxx.ns.cloudflare.com`）。
   - 登录 Namecheap → 该域名 → **Nameservers** 一项，从 “Namecheap BasicDNS”
     改成 **Custom DNS**，填入 Cloudflare 给你的那两个 nameserver。
   - 域名**注册关系仍在 Namecheap**，只是 DNS 解析改由 Cloudflare 负责。
   - 生效需要时间（**最长可能几个小时**才全网传播完成）。

7. **用固定域名启动**：

   ```bash
   TUNNEL_NAME=poker TUNNEL_HOSTNAME=poker.zifanzhang.com ./start.sh
   ```

   以后日常更新代码同样带上这两个变量：

   ```bash
   TUNNEL_NAME=poker TUNNEL_HOSTNAME=poker.zifanzhang.com ./deploy.sh
   ```

   打开 `https://poker.zifanzhang.com` 即可，网址永远不变。

### 为什么不能简单地在 Namecheap 上加一条 CNAME 指向 trycloudflare 网址？

- **临时隧道的网址会变**：`https://<随机>.trycloudflare.com` 每次重启都不一样，
  CNAME 指过去很快就失效。
- **命名隧道用的是 `*.cfargotunnel.com`，必须经过 Cloudflare 代理**：这种隧道的真正
  目标地址要靠 Cloudflare 的边缘网络（橙色云朵代理）才能解析、转发，普通注册商
  （Namecheap BasicDNS）的 DNS 解析做不到。所以**必须把域名的 DNS 托管到 Cloudflare**
  （即上面第 6 步），再用 `cloudflared tunnel route dns` 自动建好正确的记录。

---

## 方案 B：部署到服务器 / VPS（“一直在线”的替代方案）

如果你不想让发布依赖自己的 Mac 一直开机，可以把游戏部署到云主机 / VPS（例如某云的小实例）。

- 这是**“一直在线”**的方案，Mac 关机也不影响。
- 需要让 `server.js` 监听 `0.0.0.0:$PORT`（而不是只 `localhost`），并确保平台支持
  **WebSocket**（本游戏依赖 WebSocket 通信）。
- 通常**需要花钱**（按月付费），还要自己处理 HTTPS 证书、进程守护等。

> 本仓库**不实现**该方案，这里只作为对比提示。需要时再单独规划。

---

## 安全提醒（公开发布前务必看）

目前玩家身份是**客户端自报 `playerId`**，服务器**没有任何鉴权**。在临时分享、熟人之间
玩问题不大，但**一旦把服务挂到真正的公开域名上**，任何人都能冒充别人。

公开发布前请先加上**服务器签发 token 的身份鉴权**，再开放固定域名访问。

# 升级找朋友

一个完全免费、可开源、自托管的 5 人网页端扑克游戏原型。项目不依赖数据库或付费服务，服务端使用 Node.js 内置 HTTP + WebSocket 协议实现，浏览器打开即可联机。

## 本地运行

```bash
npm start
```

## 网络运行

下载Cloudflare Tunnel客户端： https://developers.cloudflare.com/tunnel/downloads/
把客户端重命名并保存在 C:\cloudflared\cloudflared.exe
```bash
PS C:\cloudflared> .\cloudflared.exe tunnel --url http://localhost:3000
```
会随机生成一个网址  https://xxxxxx.trycloudflare.com/

然后打开 (https://xxxxxx.trycloudflare.com/) 进行游戏



同一局游戏中，5 名玩家输入昵称后选择座位坐下。座位顺序决定上下家、逆时针摸牌顺序、出牌顺序以及无人叫庄时的强制庄家计数。

## 当前原型范围

- 5 人房间和座位
- 三副牌，含大小王
- 首轮随机常主点数
- 各玩家独立升级进度
- 逆时针摸牌，剩 7 张底牌
- 摸牌期间亮主抢庄
- 无人叫庄时翻底拍卖和强制庄家
- 庄家拿底、扣底、叫朋友
- 单张、对子、三张、拖拉机、甩牌的基础识别
- 跟牌校验、比牌、计分、扣底、升级结算

详细规则见 [docs/rules.md](docs/rules.md)。

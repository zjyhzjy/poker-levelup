# 升级找朋友

一个完全免费、可开源、自托管的网页端升级扑克游戏原型，支持 5 人“升级找朋友”和 6 人“隔座固定队”。项目不依赖数据库或付费服务，服务端使用 Node.js 内置 HTTP + WebSocket 协议实现，浏览器打开即可联机。

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



同一局游戏中，玩家输入昵称后选择座位坐下。座位顺序决定上下家、逆时针摸牌顺序、出牌顺序、5 人无人叫庄时的强制庄家计数，以及 6 人固定队伍归属。

## 当前原型范围

- 5 人 / 6 人房间和座位
- 三副牌，含大小王
- 5 人：独立等级、抢庄、无人叫庄翻底、找朋友
- 6 人：隔座固定队、队伍共享等级、首轮抢庄、轮庄、叫主、无人亮主换台/重发、无朋友
- 逆时针摸牌，5 人底牌 7 张，6 人底牌 6 张
- 庄家拿底、扣底、出牌
- 单张、对子、三张、拖拉机、三条拖拉机、甩牌识别
- 跟牌校验、比牌、计分、扣底、升级结算
- AI 补座、托管和推荐出牌

详细规则见 [docs/rules.md](docs/rules.md)，其中 5 人和 6 人规则已分开整理，方便新手按玩法阅读。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadAiWeights } from "./src/game.js";
import { configureHub, connectClient, createApiRoom, disconnectClient, receiveMessage, startRoomSweeper } from "./src/hub.js";
import { createFileStore } from "./src/fileStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 自对弈调参权重默认【关闭】：它在自对弈指标上看着更强(+0.46)，但实为过拟合——
// 把"给敌家送分"的惩罚调到几乎为 0(fGiftPts 3.5→0.2)、不保护自己分(fRiskOwnPts→0)，
// 实战体感很笨。故默认用出厂手调权重。要再试调参版可设 USE_TUNED_WEIGHTS=1。
if (process.env.USE_TUNED_WEIGHTS === "1") {
  try {
    const wf = path.join(__dirname, "bench", "tuned-weights.json");
    if (fs.existsSync(wf)) { const tuned = JSON.parse(fs.readFileSync(wf, "utf8")); loadAiWeights(tuned.weights || {}); console.log(`AI 权重：已载入调参权重（gen ${tuned.generation}）`); }
  } catch (e) { console.log(`AI 权重：调参权重载入失败：${e.message}`); }
} else {
  console.log("AI 权重：使用出厂手调权重（调参权重默认关闭——过拟合，实战偏笨）");
}
const publicDir = path.join(__dirname, "public");

// 最后一道防线：任何未捕获的异常/Promise 拒绝都只记录、不让进程退出，
// 避免单个 bug（如某次广播/定时器回调抛错）把整台服务器拖垮、所有人同时掉线。
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});

const port = Number(process.env.PORT || 3000);
// 单帧负载上限：防止伪造超大长度头让 recvBuffer 无限累积（内存耗尽 / DoS）。
// 6 人长局的 state 广播也远小于此。
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// 搜索型 AI 的 PIMC 预算（按难度档）。timeBudgetMs 给每步思考设上限，避免阻塞
// 服务端事件循环过久（回合制 + 友人对局可接受）。rollout 用启发式，不会递归回
// 搜索。可用环境变量覆盖时间预算。
//   强  ：轻量搜索，采样少、预算短 → 仍近乎秒出，但已用上"记牌器"推演。
//   大师：深度搜索，采样多、预算长 → 最强，出牌略慢。
const SEARCH_OPTS = {
  // 之前线上预算太小（24 次采样/400ms），把搜索"饿着"了——bench 满预算实测 +0.48 级。
  // 这里适度调大采样/时间（仍受 timeBudget 上限约束，弱网/慢机不会卡死），并让 master
  // 的 rollout 用"大师"启发式（启用强领牌），之前 rollout 硬编码 hard 导致强领牌失效。
  // 搜索每次采样之间会让出事件循环，但单次采样期间仍会阻塞（所有房间的 WS/广播/心跳都停）。
  // 所以预算保持克制：强度增益主要来自启发式（与预算几乎无关）+ master rollout 用强档。
  // 嫌慢/想更强可用 HARD_PIMC_MS / MASTER_PIMC_MS 临时调高。
  hard:   { determinizations: 40, maxCandidates: 6, timeBudgetMs: Number(process.env.HARD_PIMC_MS || 450),    rolloutLevel: "hard"   },
  master: { determinizations: 64, maxCandidates: 8, timeBudgetMs: Number(process.env.MASTER_PIMC_MS || 1300), rolloutLevel: "master" }
};
configureHub({ searchOpts: SEARCH_OPTS, store: createFileStore(path.join(__dirname, ".data", "rooms")) });
startRoomSweeper().unref?.();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    sendJson(res, { code: createApiRoom(url.searchParams.get("seatCount")) });
    return;
  }
  // 自定义图片头像：列出 public/avatars/ 里的图片文件，前端据此追加为可选头像。
  // 把你自己拥有版权/使用权的图片丢进该文件夹即可，无需改代码。
  if (url.pathname === "/api/avatars" && req.method === "GET") {
    let files = [];
    try {
      files = fs.readdirSync(path.join(publicDir, "avatars"))
        .filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f))
        .sort();
    } catch (_) { files = []; }
    sendJson(res, { avatars: files });
    return;
  }
  serveStatic(url.pathname, res);
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  // Hand the connection to the hub (it assigns a temporary playerId — may be overridden by reconnect)
  const conn = { socket, recvBuffer: null, fragments: null };
  conn.client = connectClient({
    send: (text) => sendFrame(conn, 0x1, Buffer.from(text)),
    close: () => socket.destroy()
  });
  const drop = () => disconnectClient(conn.client);
  socket.on("data", (buffer) => handleFrame(conn, buffer));
  socket.on("close", drop);
  socket.on("error", drop);
  socket.on("end", drop); // 半开 FIN（手机锁屏/切后台/弱网）也要下线，否则自动托管不触发、整桌卡死
});

server.listen(port, () => {
  console.log(`升级找朋友 running at http://localhost:${port}`);
});

function serveStatic(urlPath, res) {
  let decoded = urlPath;
  try { decoded = decodeURIComponent(urlPath); } catch (_) { /* malformed % — use raw */ }
  const safePath = decoded === "/" ? "/index.html" : decoded; // 解码后才能命中中文文件名（语音录音）
  const filePath = path.normalize(path.join(publicDir, safePath));
  // 必须落在 publicDir 之内：用「完全相等 或 以 publicDir+分隔符 开头」判断，
  // 不能只 startsWith(publicDir)——否则同级的 public-secret / public.bak 等
  // 兄弟目录（名字以 public 开头）也会通过，导致目录外文件被读出。
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    let body = data;
    // 首页里给 app.js / style.css 注入“按文件 mtime 计算的版本号”，改了前端就自动 bust
    // 浏览器/Cloudflare 缓存（首页本身 no-cache，所以每次都拿到最新版本号，无需手动改）。
    if (filePath === path.join(publicDir, "index.html")) {
      try { body = Buffer.from(data.toString("utf8").replace(/\?v=[\w.]+/g, `?v=${assetVersion()}`)); }
      catch (_) { /* 注入失败就原样发送 */ }
    }
    res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": cacheControl(filePath) });
    res.end(body);
  });
}

// 前端资源版本号 = app.js / style.css 里最新的修改时间（base36）。文件一变版本就变。
function assetVersion() {
  const mtimes = ["app.js", "style.css"].map((n) => {
    try { return fs.statSync(path.join(publicDir, n)).mtimeMs; } catch (_) { return 0; }
  });
  return Math.round(Math.max(...mtimes)).toString(36);
}

// HTML/JS/CSS 一律 no-cache（每次回源校验），保证改了代码后刷新立即生效，避免手机
// 缓存旧版导致“明明修了还看到旧的”。大体积静态资源（音频/图片）仍长缓存省流量。
function cacheControl(filePath) {
  if (/\.(html|js|css)$/i.test(filePath)) return "no-cache";
  if (/\.(mp3|wav|ogg|png|jpe?g|gif|webp|svg)$/i.test(filePath)) return "public, max-age=86400";
  return "no-cache";
}

function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendFrame(conn, opcode, data = Buffer.alloc(0)) {
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    // ≥64KB 必须用 64-bit(127) 长度，否则 16-bit 会溢出截断、整帧损坏、连接错位。
    // 6 人长局的 state 广播确实可能破 64KB。
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  conn.socket.write(Buffer.concat([header, data]));
}

// 累积每个连接的接收缓冲，只解析“完整”的帧——一个帧被 TCP 拆到多个 data 段时
// （弱网/隧道很常见）保留残片等待续传，避免长度读错导致此后所有消息全部错位。
// 同时支持分片帧（opcode 0x0 续帧 + FIN 位）。
function handleFrame(conn, chunk) {
  conn.recvBuffer = conn.recvBuffer ? Buffer.concat([conn.recvBuffer, chunk]) : chunk;
  let buf = conn.recvBuffer;
  let offset = 0;
  while (true) {
    if (buf.length - offset < 2) break;                 // 连帧头都不够
    const byte1 = buf[offset];
    const byte2 = buf[offset + 1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let len = byte2 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (buf.length - offset < 4) break;
      len = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (buf.length - offset < 10) break;
      len = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    // 拒绝异常超大帧：否则伪造的长度头会让 recvBuffer 无限累积直到内存耗尽。
    if (len > MAX_FRAME_BYTES) {
      try { conn.socket.destroy(); } catch (_) { /* already dead */ }
      conn.recvBuffer = null;
      return;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - offset < headerLen + maskLen + len) break; // 整帧未到齐，等续传
    const maskStart = offset + headerLen;
    const payloadStart = maskStart + maskLen;
    const payload = buf.subarray(payloadStart, payloadStart + len);
    if (masked) {
      const mask = buf.subarray(maskStart, maskStart + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    offset = payloadStart + len;

    if (opcode === 0x8) { conn.socket.end(); conn.recvBuffer = null; return; } // close
    if (opcode === 0x9) { sendFrame(conn, 0xA, Buffer.from(payload)); continue; } // ping -> pong
    if (opcode === 0xA) { continue; } // pong
    // 文本/二进制（0x1/0x2）与续帧（0x0）：按 FIN 组装后再分发
    if (opcode === 0x0) {
      if (!conn.fragments) continue; // 没有进行中的分片，丢弃异常续帧
      conn.fragments.push(Buffer.from(payload));
    } else {
      conn.fragments = [Buffer.from(payload)];
    }
    if (fin) {
      const full = conn.fragments.length === 1 ? conn.fragments[0] : Buffer.concat(conn.fragments);
      conn.fragments = null;
      receiveMessage(conn.client, full.toString("utf8"));
    }
  }
  conn.recvBuffer = offset >= buf.length ? null : buf.subarray(offset); // 保留未解析残片
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".wav")) return "audio/wav";
  if (filePath.endsWith(".ogg")) return "audio/ogg";
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

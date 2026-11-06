// Cloudflare 版入口：静态文件走 Workers Static Assets，/ws 和 /api/rooms 交给一个
// 全局唯一的 Durable Object（Lobby）。Lobby 里跑的就是 src/hub.js——和 Node 版同一份
// 房间逻辑，所有房间都在这一个对象的内存里，战绩快照存进它自带的存储。
//
// 用的是普通（非休眠）WebSocket：房间状态、AI/超时计时器都在内存里，有人连着时
// 对象就一直常驻；全员离开后被回收，下次进房从存储里的战绩快照恢复（与 Node 版重启后一致）。
import { DurableObject } from "cloudflare:workers";
import { configureHub, connectClient, createApiRoom, disconnectClient, receiveMessage, startRoomSweeper } from "../src/hub.js";
import { avatars } from "./avatars.gen.js";

// Durable Object 的 CPU 比本机慢一个数量级（实测同样的搜索约慢 9 倍），而且计算期间
// Date.now() 不走，timeBudgetMs 基本不起作用——所以这里直接用采样次数封顶，
// 把强/大师每步思考控制在一两秒内。
const SEARCH_OPTS = {
  hard:   { determinizations: 12, maxCandidates: 6, timeBudgetMs: 1500, rolloutLevel: "hard"   },
  master: { determinizations: 16, maxCandidates: 8, timeBudgetMs: 2500, rolloutLevel: "master" }
};

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const kv = ctx.storage.kv;
    configureHub({
      searchOpts: SEARCH_OPTS,
      store: {
        read: (code) => kv.get(`room:${code}`) ?? null,
        write: (code, text) => kv.put(`room:${code}`, text),
        remove: (code) => kv.delete(`room:${code}`),
        list: () => [...kv.list({ prefix: "room:" })].map(([key]) => key.slice(5))
      }
    });
    startRoomSweeper();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms") {
      return Response.json({ code: createApiRoom(url.searchParams.get("seatCount")) });
    }
    const [clientSide, serverSide] = Object.values(new WebSocketPair());
    serverSide.accept();
    const client = connectClient({
      send: (text) => serverSide.send(text),
      close: () => serverSide.close(1000, "replaced")
    });
    serverSide.addEventListener("message", (event) => {
      if (typeof event.data === "string") receiveMessage(client, event.data);
    });
    const drop = () => disconnectClient(client);
    serverSide.addEventListener("close", drop);
    serverSide.addEventListener("error", drop);
    return new Response(null, { status: 101, webSocket: clientSide });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const lobby = () => env.LOBBY.get(env.LOBBY.idFromName("lobby"));
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      return lobby().fetch(request);
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") return lobby().fetch(request);
    if (url.pathname === "/api/avatars" && request.method === "GET") return Response.json({ avatars });
    return env.ASSETS.fetch(request);
  }
};

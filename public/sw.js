// 升级·找朋友 PWA service worker。
// 设计对齐服务端缓存策略（HTML/JS/CSS 是 no-cache + ?v= 版本号）：
//   · 代码外壳（导航 + .html/.js/.css）→ network-first：始终先拿最新，离线再回退缓存，绝不卡旧版。
//   · 静态资源（图片/音频/字体/图标）→ cache-first：本就长缓存，顺便支持离线外壳。
//   · /api、WebSocket、其它一律不拦截，走默认网络。
const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `asset-${VERSION}`;
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|mp3|wav|ogg|woff2?|ttf)$/i;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 第三方（字体 CDN 等）放行
  if (url.pathname.startsWith("/api")) return;            // 动态接口放行，绝不缓存

  if (ASSET_RE.test(url.pathname)) {
    e.respondWith(cacheFirst(req, ASSET_CACHE));
  } else if (req.mode === "navigate" || /\.(html|js|css)$/i.test(url.pathname)) {
    e.respondWith(networkFirst(req, SHELL_CACHE));
  }
  // 其它请求不调用 respondWith → 浏览器默认处理。
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    const shell = await cache.match("/");      // 离线导航兜底首页
    if (shell) return shell;
    throw err;
  }
}

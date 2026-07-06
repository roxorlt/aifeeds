/* aifeeds Service Worker — 壳缓存,回访秒开(2026-06-11)。
 *
 * 策略(只做两件事,其余请求一概不碰):
 * 1. 导航请求(打开/刷新页面):cache-first 回缓存的壳(零网络秒开),同时后台拉新壳
 *    更新缓存 → 下次打开用新版。最多旧一个版本周期。深链(/t/ /g/ /ph/ ...)同样回壳,
 *    SPA 自己按 URL 渲染。例外:/daily 前缀是 worker 伺服的纯静态 HTML(每日日报页 +
 *    归档页),不是 SPA 路由 — 一律透传网络,不能回 SPA 壳(否则日报页被壳覆盖成空白 SPA)。
 * 2. /assets/ 哈希静态资源:cache-first(文件名带内容哈希,内容永不变)。HTTP 缓存之外
 *    多一层兜底 — iOS/微信会激进清 HTTP 缓存,Cache API 更持久。超上限删最旧。
 *
 * 不碰的:api.ai-feeds.com(数据要新鲜)、/img 与视频(Range 流式请求不能拦)、
 * fonts(HTTP 缓存已 immutable)、一切跨域与非 GET。
 *
 * 紧急停用(kill switch,见 main.tsx):
 * - 全员:发版往 index.html 加 <script>window.__SW_OFF=true</script>,SW 后台更新壳后
 *   下次打开即 unregister + 清缓存
 * - 单机:localStorage 设 aifeeds_sw_off = 1
 */
const VERSION = "v2";
const SHELL_CACHE = "aifeeds-shell-" + VERSION;
const ASSET_CACHE = "aifeeds-assets-" + VERSION;
const ASSET_MAX_ENTRIES = 80;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.add("/"))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("aifeeds-") && k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // /daily* 是 worker 伺服的纯静态日报/归档 HTML,不是 SPA 路由 — 透传网络,
  // 不能被 shellFirst 回成 SPA 壳(那会把日报页覆盖成空白单页应用)。
  if (url.pathname.startsWith("/daily")) return;
  if (req.mode === "navigate") {
    e.respondWith(shellFirst(e));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(assetFirst(req));
  }
  // 其余请求不 respondWith → 浏览器默认网络行为
});

async function shellFirst(e) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match("/");
  const refresh = fetch("/", { cache: "no-cache" })
    .then((res) => {
      if (res && res.ok) cache.put("/", res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    e.waitUntil(refresh);
    return cached;
  }
  const net = await refresh;
  if (net) return net;
  return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
}

async function assetFirst(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    cache.put(req, res.clone());
    trimCache(cache).catch(() => {});
  }
  return res;
}

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= ASSET_MAX_ENTRIES) return;
  for (const k of keys.slice(0, keys.length - ASSET_MAX_ENTRIES)) {
    await cache.delete(k);
  }
}

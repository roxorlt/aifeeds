/* aifeeds Service Worker — 壳缓存,回访秒开(2026-06-11)。
 *
 * 策略(只做两件事,其余请求一概不碰):
 * 1. 普通 SPA 导航:cache-first 回经典版壳,同时后台拉新壳
 *    更新缓存 → 下次打开用新版。最多旧一个版本周期。首页及 Drawer 深链
 *    (/t/ /g/ /ph/ ...)必须透传 SSR,让 aifeeds_view Cookie 决定经典/瀑布。
 *    例外:/daily 前缀是 worker 伺服的纯静态 HTML(每日日报页 +
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
const VERSION = "v6";
const SHELL_CACHE = "aifeeds-shell-" + VERSION;
const ASSET_CACHE = "aifeeds-assets-" + VERSION;
const ASSET_MAX_ENTRIES = 80;
const CLASSIC_SHELL_URL = "/index.html";

// worker 伺服的纯文本 SEO 文件路径判定 —— 与 worker/src/seo-routes.ts 的 isSeoPath 一字不差
// 的等价实现。根级单段 .txt(robots.txt / llms.txt / <indexnow-key>.txt)用同一条正则。
// 三层口径对齐:sw.js(本函数)/ worker isSeoPath / nginx 正则,三处放行范围必须一致。
const ROOT_TXT_RE = /^\/[A-Za-z0-9._-]+\.txt$/;
// item SSR 静态页分片 sitemap（/sitemap-<source>.xml、/sitemap-<source>-<n>.xml）—— 镜像
// worker/src/seo-routes.ts 的 SITEMAP_SHARD_RE，三层口径（sw.js / worker isSeoPath / nginx）一字不差。
const SITEMAP_SHARD_RE = /^\/sitemap-[a-z0-9-]+\.xml$/;
function isSeoPath(pathname) {
  if (pathname === "/daily" || pathname.startsWith("/daily/")) return true;
  if (pathname === "/archive" || pathname.startsWith("/archive/")) return true;
  // item SSR 静态页 /i/…（worker seo/item-routes.ts 伺服）。裸 /i 不放行(与 worker isSeoPath 同口径)。
  if (pathname.startsWith("/i/")) return true;
  if (pathname === "/sitemap.xml") return true;
  if (SITEMAP_SHARD_RE.test(pathname)) return true;
  if (ROOT_TXT_RE.test(pathname)) return true;
  return false;
}

// 必须与 src/home/viewMode.ts 的 isHomeExperiencePath 保持同一有限路由集合。
// 这些路径会根据 aifeeds_view Cookie 返回经典或瀑布 SSR，不能用固定经典壳覆盖。
function isHomeExperiencePath(pathname) {
  if (pathname === "/") return true;
  return /^\/t\/[^/]+$/.test(pathname)
    || /^\/g\/[^/]+\/[^/]+$/.test(pathname)
    || /^\/ph\/[^/]+\/[^/]+$/.test(pathname)
    || /^\/c\/[^/]+$/.test(pathname)
    || /^\/e\/[^/]+$/.test(pathname)
    || /^\/h\/[^/]+$/.test(pathname)
    || /^\/o\/[^/]+$/.test(pathname)
    || /^\/y\/[^/]+$/.test(pathname);
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.add(CLASSIC_SHELL_URL))
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
  // 首页体验路径由 Pages Function 根据显式 ?view= 或设备 Cookie 做 SSR 选择。缓存壳
  // 既不知道 Cookie,也可能来自旧版本；拦截会让刷新/冷启错误回到经典版。
  if (isHomeExperiencePath(url.pathname)) return;
  // worker 伺服的纯静态/纯文本 SEO 文件(日报页 /daily/* + 归档 /daily + sitemap.xml +
  // robots.txt / llms.txt / <indexnow-key>.txt),不是 SPA 路由 — 一律透传网络,不能被
  // shellFirst 回成 SPA 壳(否则这些文件被覆盖成空白单页应用,浏览器打开一片空白)。
  // 判定口径与 worker isSeoPath 完全对齐(见上方 isSeoPath),不误伤 /dailyxxx 之类 SPA 路由。
  if (isSeoPath(url.pathname)) return;
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
  const cached = await cache.match(CLASSIC_SHELL_URL);
  const refresh = fetch(CLASSIC_SHELL_URL, { cache: "no-cache" })
    .then((res) => {
      if (res && res.ok) cache.put(CLASSIC_SHELL_URL, res.clone());
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

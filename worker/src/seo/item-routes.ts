// item SSR 静态页公开伺服路由 `/i/:source/*`。设计文档 2026-07-08-item-ssr-pages-design.md §4.4。
//
// handleItemRoute(request, env)  —— 命中 /i/ 返回 Response；非 /i/ 返回 null → index.ts 继续后续匹配。
//
// 职责边界（薄伺服层）：URL 段反解 composite id → 查 item_pages.status + items.is_relevant → 按状态出页。
//   页面 HTML 的渲染 / 落盘全在 Task 4（item-page-run.ts 的 generateItemPage），本层只读 R2 字节 + 状态门控。
//
// 反解规则（itemPagePath 的逆向，见 render.ts）：
//   /i/x/<id>             -> x_list:<id>
//   /i/gh/<owner>/<repo>  -> github:<owner>/<repo>
//   /i/paper/<arxivId>    -> hf_paper:<arxivId>
//   /i/news/<enc id>      -> decodeURIComponent(<enc id>)（整 composite id，blog:/podcast: 前缀）
//   /i/ph/<slug>          -> D1 查该 slug 最新 product_hunt item 的 composite id（含 date）
//
// 状态门控（设计 §4.4 行为表）：
//   status=live 且 R2 命中 → 200 text/html + max-age=3600
//   status≠gone 且 item relevant 但 R2 miss → generateItemPage 兜底生成后再读 R2 → 200
//   status=gone 或 item is_relevant≠1 → 410 + <meta robots noindex> + no-store
//   未知 source / slug 无匹配 / id 无对应 item → 404 简洁页（含返回首页链接）+ no-store
//
// 关键约定：绝对 URL 一律 env.SITE_BASE（getBases），禁取 request host（HK 中转改写 Host，2026-06-08 事故）。

import type { Env } from '../index';
import { getBases } from '../digest/lib';
import { fetchItemRow } from '../digest/item-fetch';
import { itemPageR2Key } from '../digest/render';
import { generateItemPage as defaultGenerate, type ItemPageRunResult } from './item-page-run';
import { ITEM_ELIGIBILITY } from './item-archive';

// R2-miss 兜底生成器。默认走 Task 4 的 generateItemPage；测试用依赖注入替身（避免 vi.mock hoist）。
export type ItemPageGenerator = (env: Env, id: string) => Promise<ItemPageRunResult>;

// URL source 段 → composite id 前缀。ph 需 D1 反查最新行，单独走 resolvePhLatest。
function compositeFromSegs(source: string, segs: string[]): string | null {
  switch (source) {
    case 'x':
      return segs.length === 1 ? `x_list:${dec(segs[0])}` : null;
    case 'gh':
      return segs.length === 2 ? `github:${dec(segs[0])}/${dec(segs[1])}` : null;
    case 'paper':
      return segs.length === 1 ? `hf_paper:${dec(segs[0])}` : null;
    case 'news':
      // itemPagePath 把整 composite id 做 encodeURIComponent 落单段；此处反解回整 id。
      return segs.length === 1 ? dec(segs[0]) : null;
    default:
      return null; // 未知 source（ph 已在调用点前置处理）
  }
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// PH slug 白名单：composite id 的 slug 段字符集（小写字母 / 数字 / 连字符，首字符非连字符）。
// LIKE 通配符 %、_ 不在集内 → 拦 `/i/ph/%25`（解码 `%`）之类脏 URL 匹配全部 PH 返回最新 200（I1）。
const PH_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// /i/ph/<slug> → 该 slug 最新 product_hunt item 的 composite id（含 date）。无匹配 / slug 非法返回 null。
async function resolvePhLatest(env: Env, slug: string): Promise<string | null> {
  // slug 含 LIKE 通配符（% / _）或其它越界字符 → 直接判无匹配（调用点转 404），不进 D1 LIKE。
  if (!PH_SLUG_RE.test(slug)) return null;
  const row = await env.DB.prepare(
    `SELECT i.id FROM items i
     LEFT JOIN item_pages p ON p.item_id = i.id
     WHERE i.source_type = 'product_hunt' AND i.id LIKE ?
       AND ${ITEM_ELIGIBILITY}
       AND (p.status = 'live' OR p.status IS NULL)
     ORDER BY CASE WHEN p.status = 'live' THEN 0 ELSE 1 END ASC,
       COALESCE(NULLIF(i.published_at, ''), i.scraped_at) DESC, i.id DESC
     LIMIT 1`,
  )
    .bind(`product_hunt:${slug}:%`)
    .first<{ id: string }>();
  return row?.id ?? null;
}

function serveHtmlBytes(body: BodyInit): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// 410（下架 / 非 relevant）与 404（未知 / 无对应 item）小页：零可执行 script、noindex、no-store。
function statusPage(env: Env, status: 410 | 404): Response {
  const { siteBase } = getBases(env);
  const heading = status === 410 ? '内容已下架' : '内容不存在';
  const lede =
    status === 410
      ? '这条内容已从 AI Feeds 收录中移除。'
      : '没有找到对应的内容，可能链接有误或内容尚未收录。';
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} | AI Feeds</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#fafafa;color:#171717;line-height:1.65}.wrap{max-width:560px;margin:0 auto;padding:64px 20px;text-align:center}h1{font-size:20px}a{color:#0284c7;text-decoration:none}</style>
</head>
<body>
<div class="wrap">
<h1>${heading}</h1>
<p>${lede}</p>
<p><a href="${siteBase}/">← 返回首页</a></p>
</div>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleItemRoute(
  request: Request,
  env: Env,
  generate: ItemPageGenerator = defaultGenerate,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  // 非 /i/ 路径穿透（含裸 /i、/index 等）。
  if (path !== '/i' && !path.startsWith('/i/')) return null;
  // 仅伺服 GET/HEAD；其它方法交回 index.ts 兜底。
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  // 段拆分（保留 %2F，Workers 的 pathname 不解码 %2F）：['i', source, ...rest]。
  const parts = path.split('/').filter(Boolean);
  const source = parts[1] || '';
  const rest = parts.slice(2);
  if (!source || rest.length === 0) return statusPage(env, 404);

  // 反解 composite id（ph 走 D1 最新行反查，其余纯字符串反解）。
  let compositeId: string | null;
  if (source === 'ph') {
    if (rest.length !== 1) return statusPage(env, 404);
    compositeId = await resolvePhLatest(env, dec(rest[0]));
  } else {
    compositeId = compositeFromSegs(source, rest);
  }
  if (!compositeId) return statusPage(env, 404); // 未知 source / 段数不符 / ph 无匹配

  // 取 item 行（is_relevant + 存在性）与 item_pages 状态。
  const row = (await fetchItemRow(env, compositeId)) as (Record<string, unknown> & { is_relevant?: number }) | null;
  if (!row) return statusPage(env, 404); // id 无对应 item

  const statusRow = await env.DB.prepare('SELECT status FROM item_pages WHERE item_id = ?')
    .bind(compositeId)
    .first<{ status: string }>();
  const status = statusRow?.status;
  const relevant = Number(row.is_relevant) === 1;

  // 下架 / 非 relevant → 410 noindex no-store。
  if (status === 'gone' || !relevant) return statusPage(env, 410);

  // live（或尚无 item_pages 行）且 relevant：读 R2 快照。
  const key = itemPageR2Key(compositeId);
  if (!key) return statusPage(env, 404); // 出页 5 类之外（理论上不达此）
  const bucket = env.READMES;

  const hit = bucket ? await bucket.get(key) : null;
  if (hit) return serveHtmlBytes(hit.body);

  // R2 miss 但 item 存在且 relevant → 实时兜底生成后再读一次。
  // 仅 GET 触发写副作用（M2）：HEAD 探测不应引发 R2 put / D1 upsert，直接落 404 兜底。
  if (request.method === 'GET') {
    const gen = await generate(env, compositeId);
    if (!gen.skipped && bucket) {
      const regen = await bucket.get(key);
      if (regen) return serveHtmlBytes(regen.body);
    }
  }
  // 生成被跳过（relevant 中途翻转 / dedup 次源）或 HEAD 不生成或仍 miss → 404 兜底。
  return statusPage(env, 404);
}

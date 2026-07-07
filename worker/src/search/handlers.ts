// worker/src/search/handlers.ts
// C 端搜索 API：GET /api/search（分组/单源列表）+ GET /api/search/suggest（渐进联想）。
// 处理顺序（两个 handler 一致）：
//   ① Cache API 查缓存（命中直接返回，不计限流）
//   ② KV 限流（search 12/min、suggest 40/min，fail-open）
//   ③ 业务（FTS 召回 → 回查 items 五条件复检 → 排序 → 分组/列表）
//   ④ ctx.waitUntil 写缓存（search max-age=60、suggest max-age=300）
// 约束：MATCH 表达式只能来自 buildMatchQuery（禁止任何用户输入拼接）；
//       回查 items 的 SQL 必须再走一遍合规五条件（查询侧复检）；
//       响应 Item 结构与 /api/items 完全一致（复用 index.ts 的 parseItemRow）。
// 设计：docs/plans/2026-07-06-c-search-design.md §4 / §6。
import type { Env } from "../index";
import { parseItemRow } from "../item-row";
import { getClientIp } from "../client-ip";
import { tokenizeForSearch, buildMatchQuery } from "./tokenize";
import {
  rankHits,
  groupHits,
  encodeOffsetCursor,
  decodeOffsetCursor,
  RECALL_LIMIT,
  type Hit,
} from "./ranking";

// 合法 source_type 集合（与 items 表口径一致）。source 参数只允许 ∈ 此集或缺省。
const LEGAL_SOURCES = new Set([
  "x_list",
  "github",
  "product_hunt",
  "clawhub",
  "hf_paper",
  "blog",
  "podcast",
  "huodongxing",
  "youtube",
  "arxiv",
  "weibo",
]);

// 回查 items 的合规五条件（与 sync.ts extractSearchFields / handleItems 同一套口径）。
// items_fts 是异步影子表，可能滞后于 items 事后失格（软删 / is_relevant 翻转 /
// dedup / cn_sensitive 追标），故查询侧必须再复检一遍，绝不下发已失格内容。
// cn_sensitive 用 IN (1,'1') 同吃数值与字符串写法（与 reconcile ELIGIBLE_SQL 对齐）。
const ELIGIBLE_FIVE =
  "deleted_at IS NULL AND is_relevant = 1 " +
  "AND json_extract(extra,'$.workflow_completed_at') IS NOT NULL " +
  "AND json_extract(extra,'$.dedup_of') IS NULL " +
  "AND COALESCE(json_extract(extra,'$.cn_sensitive'),0) NOT IN (1,'1')";

// 回查 items 的 IN 批次上限（避免单条 SQL 绑定过多参数）。
const REQUERY_BATCH = 90;

// ─── 参数校验（纯函数，单测覆盖）────────────────────────────────────────────
// q trim 后 1-100 字符、source 必须 ∈ LEGAL_SOURCES 或缺省、limit 默认 20 上限 50 下限 1。
export function validateSearchParams(
  url: URL,
):
  | { ok: true; q: string; source: string | null; cursor: string | null; limit: number }
  | { ok: false; error: string } {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length === 0) return { ok: false, error: "empty_query" };
  if (q.length > 100) return { ok: false, error: "query_too_long" };

  const sourceRaw = url.searchParams.get("source");
  let source: string | null = null;
  if (sourceRaw != null && sourceRaw !== "") {
    if (!LEGAL_SOURCES.has(sourceRaw)) return { ok: false, error: "invalid_source" };
    source = sourceRaw;
  }

  const cursor = url.searchParams.get("cursor");

  const limitParsed = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Math.max(1, Math.min(50, Number.isFinite(limitParsed) ? limitParsed : 20));

  return { ok: true, q, source, cursor: cursor ?? null, limit };
}

// ─── 通用工具 ──────────────────────────────────────────────────────────────

// JSON 响应。cacheControl 缺省时用 no-store（错误响应不该被中间层缓存）。
function jsonResp(body: unknown, status: number, cacheControl?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl ?? "no-store",
    },
  });
}

// Cache API key：https://search-cache.internal + path + 归一化排序后的参数串。
// 空值参数剔除，键按字典序排序 → 同一逻辑查询恒定命中同一 cache 条目。
function cacheKeyFor(path: string, params: [string, string | null][]): Request {
  const qs = params
    .filter((p): p is [string, string] => p[1] != null && p[1] !== "")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return new Request(`https://search-cache.internal${path}?${qs}`);
}

// KV 限流。身份优先 X-Device-Id，缺失用真实 IP，最后 "anon"。
// 每分钟一个 bucket，TTL 120s（上一分钟 bucket 尚在，避免边界抖动）。
// fail-open：KV 读写异常一律放行 —— 限流器故障不该拒绝正常用户。
async function checkRateLimit(
  env: Env,
  request: Request,
  kind: "search" | "suggest",
): Promise<boolean> {
  try {
    const id = request.headers.get("X-Device-Id") || getClientIp(request, env) || "anon";
    const bucket = Math.floor(Date.now() / 60000);
    const key = `search:rl:${kind}:${id}:${bucket}`;
    const cur = parseInt((await env.AUTH_KV.get(key)) || "0", 10) + 1;
    await env.AUTH_KV.put(key, String(cur), { expirationTtl: 120 });
    return cur <= (kind === "suggest" ? 40 : 12);
  } catch (e) {
    console.error("[search] rate limit check failed (fail-open):", e);
    return true;
  }
}

// 召回集单条 hit（携带 bm25 分与完整 item 行，供排序与响应映射）。
type SearchHit = Hit & { id: string; row: Record<string, unknown> };

// ─── GET /api/search ────────────────────────────────────────────────────────
export async function handleSearch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const t0 = Date.now();
  try {
    const url = new URL(request.url);

    // ① 参数校验（400 直接返回，不进缓存 / 限流）。
    const v = validateSearchParams(url);
    if (!v.ok) return jsonResp({ error: v.error }, 400);

    // MATCH 表达式唯一入口：分词 → buildMatchQuery。null（无有效 token）→ empty_query。
    const match = buildMatchQuery(tokenizeForSearch(v.q));
    if (!match) return jsonResp({ error: "empty_query" }, 400);

    // ① Cache API：命中直接返回（不计限流）。
    const cache = caches.default;
    const key = cacheKeyFor("/api/search", [
      ["q", v.q],
      ["source", v.source],
      ["cursor", v.cursor],
      ["limit", String(v.limit)],
    ]);
    const cached = await cache.match(key);
    if (cached) return cached;

    // ② KV 限流。
    if (!(await checkRateLimit(env, request, "search"))) {
      return jsonResp({ error: "rate_limited" }, 429);
    }

    // ③ 业务：FTS 召回（bm25 权重 title 5 / body 1 / author 3，时间倒序无关，纯相关性）。
    let recallSql =
      "SELECT item_id AS id, source_type, published_at, " +
      "bm25(items_fts, 5.0, 1.0, 3.0) AS b FROM items_fts WHERE items_fts MATCH ?";
    const recallBinds: unknown[] = [match];
    if (v.source) {
      recallSql += " AND source_type = ?";
      recallBinds.push(v.source);
    }
    recallSql += ` ORDER BY b LIMIT ${RECALL_LIMIT}`;
    const recallRes = await env.DB.prepare(recallSql)
      .bind(...recallBinds)
      .all<{ id: string; source_type: string; published_at: string | null; b: number }>();
    const recall = recallRes.results ?? [];

    // 回查 items（按 90 个 id 一批），附加合规五条件（查询侧复检）。滞后失格行不进 map → 被丢弃。
    const rowMap = new Map<string, Record<string, unknown>>();
    const ids = recall.map((r) => r.id);
    for (let i = 0; i < ids.length; i += REQUERY_BATCH) {
      const batch = ids.slice(i, i + REQUERY_BATCH);
      if (batch.length === 0) continue;
      const ph = batch.map(() => "?").join(",");
      const res = await env.DB.prepare(
        `SELECT * FROM items WHERE id IN (${ph}) AND ${ELIGIBLE_FIVE}`,
      )
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const row of res.results ?? []) rowMap.set(row.id as string, row);
    }

    // 保留召回顺序重建 hits（带 bm25 分），仅纳入通过复检的行。
    const hits: SearchHit[] = [];
    for (const r of recall) {
      const row = rowMap.get(r.id);
      if (!row) continue;
      hits.push({ id: r.id, source_type: r.source_type, published_at: r.published_at, b: r.b, row });
    }

    const ranked = rankHits(hits, Date.now());

    // 缓存写入闭包：先构造 200 响应，clone 进边缘缓存（后台），返回原响应。
    const respond = (body: unknown): Response => {
      const resp = jsonResp(body, 200, "public, max-age=60");
      ctx.waitUntil(
        cache.put(key, resp.clone()).catch((e) => console.error("[search] cache put failed:", e)),
      );
      return resp;
    };

    if (!v.source) {
      // 无 source：分组模式。每组 total = 召回集内该源命中数（≤ RECALL_LIMIT，200+ 截断语义）。
      const groups = groupHits(ranked).map((g) => ({
        source_type: g.source_type,
        total: g.total,
        items: g.top.map((h) => parseItemRow(h.row)),
      }));
      return respond({ mode: "grouped", groups, query_time_ms: Date.now() - t0 });
    }

    // 有 source：单源列表，offset cursor 切片。
    const offset = decodeOffsetCursor(v.cursor);
    const slice = ranked.slice(offset, offset + v.limit);
    const hasMore = offset + v.limit < ranked.length;
    return respond({
      mode: "list",
      items: slice.map((h) => parseItemRow(h.row)),
      next_cursor: hasMore ? encodeOffsetCursor(offset + v.limit) : null,
      has_more: hasMore,
      query_time_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error("[search] handleSearch failed:", e);
    return jsonResp({ error: "search_unavailable" }, 500);
  }
}

// ─── GET /api/search/suggest ─────────────────────────────────────────────────
// 联想永不阻塞主流程：任何内部错误 → 200 { terms: [] }。仅显式过长 prefix 返 400。
export async function handleSearchSuggest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    // prefix 归一：NFKC + lowercase + trim（与 terms.ts normTerm / term_norm 一致）。
    const prefix = (url.searchParams.get("prefix") ?? "").normalize("NFKC").toLowerCase().trim();
    if (prefix.length > 50) return jsonResp({ error: "query_too_long" }, 400);

    // ① Cache API。
    const cache = caches.default;
    const key = cacheKeyFor("/api/search/suggest", [["prefix", prefix]]);
    const cached = await cache.match(key);
    if (cached) return cached;

    // ② KV 限流。超限时联想不阻塞：返回 200 空数组（而非 429），前端无需特判。
    if (!(await checkRateLimit(env, request, "suggest"))) {
      return jsonResp({ terms: [] }, 200);
    }

    // ③ 业务。
    let rows: { term: string; term_type: string }[];
    if (prefix === "") {
      // 空 prefix「大家在搜」：hot_query 永远置顶，entity 补位时排除作者类词
      // （term_type='entity' AND source_type IN ('x_list','podcast')）—— 作者词只产自
      // 这两个源，热门作者按出现次数计权会霸榜，压掉 GH 仓库名 / PH 产品名等检索引导词。
      // 前缀联想分支不做此排除（输入作者名前缀联想出作者是合理的）。
      const res = await env.DB.prepare(
        "SELECT term, term_type FROM search_terms " +
          "WHERE NOT (term_type = 'entity' AND source_type IN ('x_list','podcast')) " +
          "ORDER BY CASE term_type WHEN 'hot_query' THEN 0 ELSE 1 END, weight DESC LIMIT 10",
      ).all<{ term: string; term_type: string }>();
      rows = res.results ?? [];
    } else {
      // 非空 prefix：term_norm 前缀范围查询。上界 = prefix + U+FFFF（JS 侧算，绑定第二参数）。
      const ub = prefix + "￿";
      const res = await env.DB.prepare(
        "SELECT term, term_type FROM search_terms " +
          "WHERE term_norm >= ? AND term_norm < ? ORDER BY weight DESC LIMIT 8",
      )
        .bind(prefix, ub)
        .all<{ term: string; term_type: string }>();
      rows = res.results ?? [];
    }

    const body = { terms: rows.map((r) => ({ term: r.term, term_type: r.term_type })) };
    const resp = jsonResp(body, 200, "public, max-age=300");
    ctx.waitUntil(
      cache.put(key, resp.clone()).catch((e) => console.error("[search] suggest cache put failed:", e)),
    );
    return resp;
  } catch (e) {
    // 联想永不阻塞：任何异常回落空数组（200）。
    console.error("[search] handleSearchSuggest failed:", e);
    return jsonResp({ terms: [] }, 200);
  }
}

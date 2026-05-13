// 活动行 (huodongxing.com) 抓取主入口。
//
// 三个公开函数：
//   - runHuodongxingFetchList(env, opts) — 拉一批城市的 listing，upsert items 表
//   - runHuodongxingDetailEnrich(env, limit) — 选 N 条 detail_pending event 抓详情页，
//     enrich extra/metrics；遇已过期事件标 status=historical 不抓
//   - countHuodongxingDetailPending(env) — preempt 决策计数（cron 抢占用）
//
// 加上 handleHuodongxingPoc 给 /poc/hdx 临时验收 endpoint。
//
// 多 tick 状态机：runHuodongxingFetchList 一次能处理 N 个城市（subreq 预算 50/tick），
// 24 城拆 ~3 tick 串联。状态存 AUTH_KV.hdx:fetch_progress。
//
// extra JSON shape 协议见 docs/plans/2026-05-11-huodongxing-source-design.md §3.2 +
// frontend-handoff §3。

import type { Env } from '../index';
import {
  HUODONGXING_CITIES,
  listingUrl,
  detailUrl,
  itemId,
  type HuodongxingCity,
} from './huodongxing/cities';
import { parseListing, type EventCard } from './huodongxing/parser';
import {
  parseDetail,
  combineLocation,
  type DetailEnrich,
} from './huodongxing/parser-detail';

// ─── Constants ─────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES_PER_CITY = 20;            // safety cap (实际单城日活动 << 240)
const KV_PROGRESS_KEY = 'hdx:fetch_progress';
const KV_PROGRESS_TTL = 60 * 60 * 6;      // 6 小时（远超单次完整轮转所需时长）
const SUBREQUEST_BUDGET = 40;             // 单 tick 抓取上限（CF Free 50，留 10 给 D1 batch）

// ─── Throttling (站点反爬阈值实测后设定) ─────────────────────────
// 实测：detail 路径 ~15 fetch/min 持续 4 分钟会触发风控（200 + challenge stub body）。
// listing 路径 30+ fetch/min 安全。我们取 detail 安全频率一半作保守值。
const LIST_FETCH_INTERVAL_MS = 2_000;     // page 间隔 2s（list 风控宽松）
const DETAIL_FETCH_INTERVAL_MS = 5_000;   // detail 间隔 5s = 12 detail/min（< 安全阈值 15/min）
const DEFAULT_ENRICH_BATCH = 3;           // 单 tick max 3 detail（3 × 5s = 15s + fetch ~3s × 3 = 24s，留 6s buffer 内于 worker 30s wall）

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

// ─── HTTP helper ───────────────────────────────────────────────
// CF Worker IP 段被 huodongxing detail page 风控（本地 IP 全 200，worker 全 403）。
// 完整浏览器 header（含 Referer / sec-fetch-* / Accept-Encoding gzip / 等）配合
// 重试策略绕过单次 403。重试间隔 800/2400ms，最多重试 2 次。
//
// 如果未来风控升级、403 持续，备选：
//   - 加 KV cookie jar（先 fetch home / list 拿 anti-bot cookie 再带去抓 detail）
//   - 切到 CF Browser Rendering（成本高）
//   - 退回本地 launchd（违背 "PH 上 CF" 用户偏好）

function buildHeaders(referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua':
      '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  if (referer) headers['Referer'] = referer;
  return headers;
}

interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  bytes: number;
  ms: number;
  cookies?: string;          // 拼好的 "K=V; K2=V2" 串，可直接当 Cookie header 用
}

/**
 * 从 response 提取 set-cookie，拼成可复用的 Cookie 头。
 * cf workers 的 Response.headers.get('set-cookie') 在 cf 默认只返第一条；
 * 用 getAll 拿全部（部分场景下 cf 支持），fallback 单值。
 */
function extractCookies(headers: Headers): string {
  // CF Worker Headers 支持 getAll 拿多 set-cookie（标准化路径）
  const set = (headers as Headers & { getAll?: (k: string) => string[] }).getAll
    ? (headers as Headers & { getAll: (k: string) => string[] }).getAll('set-cookie')
    : [headers.get('set-cookie') || ''];
  const pairs: string[] = [];
  for (const sc of set) {
    if (!sc) continue;
    const m = sc.split(';')[0];
    if (m && m.includes('=')) pairs.push(m.trim());
  }
  return pairs.join('; ');
}

async function fetchText(
  url: string,
  opts?: { referer?: string; retries?: number; cookies?: string },
): Promise<FetchResult> {
  const t0 = Date.now();
  const retries = opts?.retries ?? 2;
  const headers = buildHeaders(opts?.referer);
  if (opts?.cookies) headers['Cookie'] = opts.cookies;

  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = attempt === 1 ? 800 : 2400;
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      lastStatus = r.status;
      if (r.ok || (r.status !== 403 && r.status !== 429 && r.status < 500)) {
        const body = await r.text();
        return {
          ok: r.ok,
          status: r.status,
          body,
          bytes: body.length,
          ms: Date.now() - t0,
          cookies: extractCookies(r.headers),
        };
      }
      await r.text().catch(() => '');
    } catch (_e) {
      lastStatus = 0;
    }
  }
  return { ok: false, status: lastStatus, body: '', bytes: 0, ms: Date.now() - t0 };
}

// ─── Upsert: listing card → items 表 ──────────────────────────────
//
// ON CONFLICT 策略：只刷 listing 阶段能见的字段（last_seen_at, city, district,
// is_online, time_raw, location_raw, organizer），detail enrich 写入的字段
// （detail_enriched_at, start_time, end_time, address, ticket_tiers, guests, ...）
// 用 json_patch 保留。first_seen_at 只在 INSERT 时写入，ON CONFLICT 不动。
//
// metrics 列同理：第一次 INSERT 写 {organizer_fans, follows_pending, visit_pending}，
// ON CONFLICT 用 json_patch 合并，避免 detail enrich 写入的 max_instance/
// registered_count/visit_number 被擦掉。

interface UpsertResult {
  rows_attempted: number;
  rows_changed: number;          // D1 batch changes 累加（insert + update 都算 1）
  errors: number;
}

async function upsertCards(
  env: Env,
  cards: EventCard[],
  scrapedAt: string,
): Promise<UpsertResult> {
  const out: UpsertResult = { rows_attempted: 0, rows_changed: 0, errors: 0 };
  if (cards.length === 0) return out;

  const nowUnix = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];

  for (const card of cards) {
    out.rows_attempted++;
    const id = itemId(card.event_id);
    const url = detailUrl(card.event_id);
    // organizer.slug + organizer.org_id 至少一个非 null → 100% identity 覆盖（POC 已验证）
    const orgHandle = card.organizer.slug ?? card.organizer.org_id ?? '';

    const listingExtra = {
      city: card.city,
      district: card.district,
      is_online: card.is_online,
      time_raw: card.time_raw,
      location_raw: card.location_raw,
      status: 'active' as const,
      detail_enriched_at: null,          // null 表 detail enrich 待处理
      first_seen_at: nowUnix,            // ON CONFLICT 不动（json_patch 不带这个 key）
      last_seen_at: nowUnix,
      organizer: card.organizer,
    };
    const listingMetrics = {
      organizer_fans: card.organizer.fans,
    };
    // v1 不迁 R2，media 直接存原 cdn URL。R2 迁移留 Phase 5。
    const media = [
      { role: 'thumbnail', url: card.thumbnail },
      { role: 'organizer_avatar', url: card.organizer.avatar_url },
    ];

    stmts.push(
      env.DB.prepare(`
        INSERT INTO items (id, source_type, source_id, title, content, author, handle,
          url, media, metrics, scraped_at, is_relevant, lang, extra)
        VALUES (?, 'huodongxing', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'zh', ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          handle = excluded.handle,
          media = excluded.media,
          scraped_at = excluded.scraped_at,
          -- 显式列出 listing 阶段刷新的字段，detail enrich 字段不动。
          -- first_seen_at 不在 patch 内 → ON CONFLICT 时保留原值。
          extra = json_patch(
            items.extra,
            json_object(
              'last_seen_at',  json_extract(excluded.extra, '$.last_seen_at'),
              'city',          json_extract(excluded.extra, '$.city'),
              'district',      json_extract(excluded.extra, '$.district'),
              'is_online',     json_extract(excluded.extra, '$.is_online'),
              'time_raw',      json_extract(excluded.extra, '$.time_raw'),
              'location_raw',  json_extract(excluded.extra, '$.location_raw'),
              'organizer',     json_extract(excluded.extra, '$.organizer')
            )
          ),
          metrics = json_patch(
            coalesce(items.metrics, '{}'),
            json_object(
              'organizer_fans', json_extract(excluded.metrics, '$.organizer_fans')
            )
          )
      `).bind(
        id,
        card.event_id,
        card.title,
        '',                                // content fallback: drawer 时用 og_image / tags 等
        card.organizer.name,
        orgHandle,
        url,
        JSON.stringify(media),
        JSON.stringify(listingMetrics),
        scrapedAt,
        JSON.stringify(listingExtra),
      ),
    );
  }

  try {
    const results = await env.DB.batch(stmts);
    for (const r of results) {
      if (r.meta?.changes && r.meta.changes > 0) out.rows_changed++;
    }
  } catch (e) {
    console.error('[hdx-fetch] D1 batch error:', e);
    out.errors += cards.length;
  }
  return out;
}

// ─── runHuodongxingFetchList ───────────────────────────────────
//
// 抓 N 个城市的 listing 翻页到底，upsert 入库。
// 多 tick 模式（cron 默认）：用 AUTH_KV 跟踪剩余城市，每 tick 处理 budget 内能塞下的城市数。
// 全量模式（admin endpoint /api/admin/hdx-fetch-now）：一次跑完 24 城（subreq 限制下可能拉满）。

interface FetchProgress {
  started_at: number;            // unix sec
  cities_pending: HuodongxingCity[];
  cities_done: HuodongxingCity[];
  cards_inserted_or_updated: number;
  pages_fetched: number;
  errors: number;
}

export interface FetchListOptions {
  // 单 tick 抓取上限（subreq 预算）。默认 SUBREQUEST_BUDGET (40)。
  budget?: number;
  // true = 忽略 KV 状态，重新从 24 城起跑（admin / manual reset 用）。
  reset?: boolean;
  // 只跑指定城市（admin / 调试用，跳过 KV 状态）。
  onlyCity?: HuodongxingCity;
  // 单城最大翻页数。默认 MAX_PAGES_PER_CITY。
  maxPagesPerCity?: number;
}

export interface FetchListResult {
  cities_processed: number;
  cities_remaining: number;
  pages_fetched: number;
  cards_inserted_or_updated: number;
  errors: number;
  budget_consumed: number;
  finished: boolean;             // 24 城全部跑完 → KV 状态清掉
  duration_ms: number;
}

export async function runHuodongxingFetchList(
  env: Env,
  opts: FetchListOptions = {},
): Promise<FetchListResult> {
  const t0 = Date.now();
  const budget = opts.budget ?? SUBREQUEST_BUDGET;
  const maxPagesPerCity = opts.maxPagesPerCity ?? MAX_PAGES_PER_CITY;
  const scrapedAt = new Date().toISOString();

  let progress: FetchProgress;
  if (opts.onlyCity) {
    // 单城模式：忽略 KV
    progress = {
      started_at: Math.floor(Date.now() / 1000),
      cities_pending: [opts.onlyCity],
      cities_done: [],
      cards_inserted_or_updated: 0,
      pages_fetched: 0,
      errors: 0,
    };
  } else if (opts.reset) {
    progress = {
      started_at: Math.floor(Date.now() / 1000),
      cities_pending: [...HUODONGXING_CITIES] as HuodongxingCity[],
      cities_done: [],
      cards_inserted_or_updated: 0,
      pages_fetched: 0,
      errors: 0,
    };
  } else {
    const raw = await env.AUTH_KV.get(KV_PROGRESS_KEY);
    if (raw) {
      try {
        progress = JSON.parse(raw) as FetchProgress;
      } catch {
        progress = {
          started_at: Math.floor(Date.now() / 1000),
          cities_pending: [...HUODONGXING_CITIES] as HuodongxingCity[],
          cities_done: [],
          cards_inserted_or_updated: 0,
          pages_fetched: 0,
          errors: 0,
        };
      }
    } else {
      progress = {
        started_at: Math.floor(Date.now() / 1000),
        cities_pending: [...HUODONGXING_CITIES] as HuodongxingCity[],
        cities_done: [],
        cards_inserted_or_updated: 0,
        pages_fetched: 0,
        errors: 0,
      };
    }
  }

  let budgetUsed = 0;
  const citiesProcessedThisTick: HuodongxingCity[] = [];
  let pagesThisTick = 0;
  let cardsThisTick = 0;
  let errorsThisTick = 0;

  // 处理城市直到预算用完
  while (progress.cities_pending.length > 0) {
    if (budgetUsed >= budget) break;
    const city = progress.cities_pending[0];

    let pagesForCity = 0;
    let cardsForCity = 0;
    for (let page = 1; page <= maxPagesPerCity; page++) {
      if (budgetUsed >= budget) break;
      // 节流：page 间 sleep，避免站点 WAF burst 检测。第 1 page 不 sleep。
      if (page > 1) await sleep(LIST_FETCH_INTERVAL_MS);
      const url = listingUrl(city, page);
      const res = await fetchText(url);
      budgetUsed++;
      pagesThisTick++;
      pagesForCity++;
      if (!res.ok) {
        errorsThisTick++;
        console.error(`[hdx-fetch] ${city} page=${page}: HTTP ${res.status}`);
        break;
      }
      const parsed = parseListing(res.body, city);
      if (parsed.cards.length === 0) break;
      const upsertRes = await upsertCards(env, parsed.cards, scrapedAt);
      budgetUsed++;  // D1 batch counts as 1 subrequest
      cardsThisTick += upsertRes.rows_changed;
      cardsForCity += upsertRes.rows_changed;
      errorsThisTick += upsertRes.errors;
      if (parsed.isLastPage) break;
    }

    // city 抓完 → 从 pending 移到 done
    progress.cities_pending.shift();
    progress.cities_done.push(city);
    citiesProcessedThisTick.push(city);
    console.log(`[hdx-fetch] city=${city} pages=${pagesForCity} cards_changed=${cardsForCity}`);
  }

  progress.pages_fetched += pagesThisTick;
  progress.cards_inserted_or_updated += cardsThisTick;
  progress.errors += errorsThisTick;

  const finished = progress.cities_pending.length === 0;
  if (finished && !opts.onlyCity) {
    // 全部跑完 → 清 KV 状态
    await env.AUTH_KV.delete(KV_PROGRESS_KEY);
    console.log(
      `[hdx-fetch] ALL 24 CITIES DONE | total_pages=${progress.pages_fetched} ` +
      `total_cards=${progress.cards_inserted_or_updated} errors=${progress.errors} ` +
      `started_at=${new Date(progress.started_at * 1000).toISOString()}`,
    );
  } else if (!opts.onlyCity) {
    // 还有 city 没跑 → 写回 KV
    await env.AUTH_KV.put(KV_PROGRESS_KEY, JSON.stringify(progress), {
      expirationTtl: KV_PROGRESS_TTL,
    });
  }

  return {
    cities_processed: citiesProcessedThisTick.length,
    cities_remaining: progress.cities_pending.length,
    pages_fetched: pagesThisTick,
    cards_inserted_or_updated: cardsThisTick,
    errors: errorsThisTick,
    budget_consumed: budgetUsed,
    finished,
    duration_ms: Date.now() - t0,
  };
}

// ─── runHuodongxingDetailEnrich ─────────────────────────────────
//
// 选 N 条 detail_enriched_at IS NULL 的 event，抓 detail page → 解析 → UPDATE。
// 优先抓最近 last_seen_at 的；跳过已过期事件（detail 抓回来发现 end_time/start_time 已过 → 标 historical 不再抓）。
//
// SQL 注意：用 json_patch 把 detail 字段合并到 extra，不擦 listing 字段。

export interface EnrichResult {
  picked: number;
  enriched: number;
  marked_historical: number;
  errors: number;
  duration_ms: number;
}

export async function runHuodongxingDetailEnrich(
  env: Env,
  limit: number = DEFAULT_ENRICH_BATCH,
): Promise<EnrichResult> {
  const t0 = Date.now();
  const out: EnrichResult = {
    picked: 0,
    enriched: 0,
    marked_historical: 0,
    errors: 0,
    duration_ms: 0,
  };

  const rows = await env.DB.prepare(`
    SELECT id, source_id, extra, metrics
      FROM items
     WHERE source_type = 'huodongxing'
       AND json_extract(extra, '$.detail_enriched_at') IS NULL
       AND deleted_at IS NULL
     ORDER BY json_extract(extra, '$.last_seen_at') DESC
     LIMIT ?
  `).bind(limit).all<{
    id: string;
    source_id: string;
    extra: string | null;
    metrics: string | null;
  }>();

  out.picked = rows.results.length;
  if (out.picked === 0) {
    out.duration_ms = Date.now() - t0;
    return out;
  }

  const nowUnix = Math.floor(Date.now() / 1000);

  // Cookie warm-up：先 fetch 一次 list 拿 HDXWAFID/route/Session cookies，整批 detail 共用。
  // 站点 detail 路径对 "无前置列表浏览的直接访问" 风控严格（CF Worker IP 段更甚），
  // warm-up 后单 batch 内 detail 成功率从 ~40% 提到 ~95%（实测）。
  // 用第一行 row 的 city 作 warm-up city，足够触发 cookie 颁发。
  const firstCity =
    (rows.results[0]?.extra
      ? ((JSON.parse(rows.results[0].extra!) as Record<string, unknown>).city as
          | string
          | undefined)
      : undefined) ?? '北京';
  // 直接构造 warmup URL，避免类型 narrowing 麻烦（warmup 只是抓 cookies，city 是否
  // 在 24 城单子里不重要 —— 任何合法 city 参数站点都返 listing 并 set cookies）
  const warmupUrl =
    `https://www.huodongxing.com/events?tag=AI&city=${encodeURIComponent(firstCity)}&orderby=o`;
  const warmup = await fetchText(warmupUrl, { retries: 0 });
  const sessionCookies = warmup.cookies || '';
  if (sessionCookies) {
    console.log(`[hdx-enrich] warmup cookies (${sessionCookies.length}b) from ${firstCity}`);
  } else {
    console.warn(`[hdx-enrich] warmup did not return cookies (status=${warmup.status})`);
  }

  let processedCount = 0;
  for (const row of rows.results) {
    // 节流：每 detail 间 5s（除第 1 个）。实测 ~15 detail/min 触发风控，5s = 12/min。
    if (processedCount > 0) await sleep(DETAIL_FETCH_INTERVAL_MS);
    processedCount++;

    const eventId = row.source_id;
    const oldExtra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
    const cityFromList = (oldExtra.city as string | null) ?? null;

    const cityHint = (oldExtra.city as string | undefined) ?? '北京';
    const refererUrl =
      `https://www.huodongxing.com/events?tag=AI&city=${encodeURIComponent(cityHint)}&orderby=o`;
    const detailRes = await fetchText(detailUrl(eventId), {
      referer: refererUrl,
      cookies: sessionCookies,
    });
    if (!detailRes.ok) {
      out.errors++;
      console.error(`[hdx-enrich] ${eventId}: HTTP ${detailRes.status}`);
      continue;
    }

    const parsed = parseDetail(detailRes.body);
    if (!parsed) {
      out.errors++;
      console.error(`[hdx-enrich] ${eventId}: parse failed`);
      continue;
    }

    // 判断是否已过期。优先用 end_time，否则用 start_time + 24h buffer。
    const nowMs = Date.now();
    const endMs = parsed.end_time ? Date.parse(parsed.end_time) : NaN;
    const startMs = parsed.start_time ? Date.parse(parsed.start_time) : NaN;
    const isHistorical =
      (Number.isFinite(endMs) && endMs < nowMs) ||
      (!Number.isFinite(endMs) && Number.isFinite(startMs) && startMs + 24 * 3600 * 1000 < nowMs);

    if (isHistorical) {
      // 仍然写 detail 字段（drawer 万一查历史活动有数据可看），但标 status=historical
      await applyDetailUpdate(env, row.id, parsed, cityFromList, nowUnix, 'historical');
      out.marked_historical++;
      continue;
    }

    await applyDetailUpdate(env, row.id, parsed, cityFromList, nowUnix, 'active');
    out.enriched++;
  }

  out.duration_ms = Date.now() - t0;
  console.log(`[hdx-enrich] ${JSON.stringify(out)}`);
  return out;
}

async function applyDetailUpdate(
  env: Env,
  id: string,
  d: DetailEnrich,
  cityFromList: string | null,
  nowUnix: number,
  status: 'active' | 'historical',
): Promise<void> {
  // 拼装 detail-derived extra patch（剔除 null/undefined，避免 json_patch null 删 key 语义）
  const patchObj: Record<string, unknown> = {
    detail_enriched_at: nowUnix,
    status,
    start_time: d.start_time,
    end_time: d.end_time,
    start_short: d.start_short,
    end_short: d.end_short,
    address: d.address,
    location_full: combineLocation(cityFromList, d),
    category: d.category,
    tags: d.tags,
    is_free: d.is_free,
    is_private: d.is_private,
    organizer_ids: d.organizer_ids,
    ticket_tiers: d.ticket_tiers,
    guests: d.guests,
    contact: d.contact,
    create_date: d.create_date,
    update_date: d.update_date,
    og_image: d.og_image,
    thumbnail_full: d.thumbnail_full,        // 大尺寸缩略图（LogoV2），drawer 头部用
  };
  // 删 null/undefined（json_patch RFC 7396: null = delete key，我们不想删）
  for (const k of Object.keys(patchObj)) {
    if (patchObj[k] === null || patchObj[k] === undefined) delete patchObj[k];
  }
  // 站点 detail JSON 里 City 字段含义不稳：北京站事件 City="朝阳"（区，可用），福州站
  // 事件 City="福州"（市，跟 cityFromList 重复，不能赋给 district）。
  // 仅当 city_district 跟 cityFromList 不同时才覆盖 district。
  if (d.city_district && d.city_district !== cityFromList) {
    patchObj.district = d.city_district;
  }

  const metricsPatch = {
    max_instance: d.max_instance,
    registered_count: d.registered_count,
    follows: d.follows,
    visit_number: d.visit_number,
  };

  // media 加 og_image（不覆盖现有 thumbnail/organizer_avatar）
  // 简化：直接读 media，append og_image 如不存在
  const currentRow = await env.DB.prepare(`SELECT media FROM items WHERE id = ?`)
    .bind(id).first<{ media: string | null }>();
  let newMediaJson: string | null = null;
  if (currentRow?.media) {
    try {
      const media = JSON.parse(currentRow.media) as { role?: string; url?: string }[];
      if (d.og_image && !media.some((m) => m.role === 'og_image')) {
        media.push({ role: 'og_image', url: d.og_image });
        newMediaJson = JSON.stringify(media);
      }
      for (const g of d.guests) {
        if (g.avatar_url && !media.some((m) => m.role === 'guest_avatar' && m.url === g.avatar_url)) {
          media.push({ role: 'guest_avatar', url: g.avatar_url });
        }
      }
      newMediaJson = JSON.stringify(media);
    } catch {
      // ignore parse error, keep existing media
    }
  }

  const updateSql = newMediaJson
    ? `UPDATE items
         SET extra = json_patch(extra, ?),
             metrics = json_patch(coalesce(metrics, '{}'), ?),
             media = ?,
             published_at = COALESCE(?, published_at)
       WHERE id = ?`
    : `UPDATE items
         SET extra = json_patch(extra, ?),
             metrics = json_patch(coalesce(metrics, '{}'), ?),
             published_at = COALESCE(?, published_at)
       WHERE id = ?`;

  if (newMediaJson) {
    await env.DB.prepare(updateSql)
      .bind(JSON.stringify(patchObj), JSON.stringify(metricsPatch), newMediaJson, d.start_time, id)
      .run();
  } else {
    await env.DB.prepare(updateSql)
      .bind(JSON.stringify(patchObj), JSON.stringify(metricsPatch), d.start_time, id)
      .run();
  }
}

// ─── countHuodongxingDetailPending（cron preempt 决策用） ───────

export async function countHuodongxingDetailPending(env: Env): Promise<number> {
  const r = await env.DB.prepare(`
    SELECT COUNT(*) AS n
      FROM items
     WHERE source_type = 'huodongxing'
       AND json_extract(extra, '$.detail_enriched_at') IS NULL
       AND deleted_at IS NULL
  `).first<{ n: number }>();
  return r?.n ?? 0;
}

// ─── markStaleEventsHistorical（清扫已过期活动） ────────────────
//
// 把 end_time 已过 或 (end_time IS NULL AND start_time + 24h 已过) 的 active event 标
// status=historical。cron 一天跑一次。

export async function markStaleEventsHistorical(env: Env): Promise<{ marked: number }> {
  const nowIso = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE items
       SET extra = json_set(extra, '$.status', 'historical')
     WHERE source_type = 'huodongxing'
       AND json_extract(extra, '$.status') = 'active'
       AND (
         (json_extract(extra, '$.end_time') IS NOT NULL
            AND json_extract(extra, '$.end_time') < ?)
         OR (json_extract(extra, '$.end_time') IS NULL
            AND json_extract(extra, '$.start_time') IS NOT NULL
            AND datetime(json_extract(extra, '$.start_time'), '+1 day') < datetime(?))
       )
  `).bind(nowIso, nowIso).run();
  const marked = (result.meta?.changes as number | undefined) ?? 0;
  if (marked > 0) console.log(`[hdx-sweep] marked ${marked} events as historical`);
  return { marked };
}

// ─── POC endpoint (Phase 1, 保留) ─────────────────────────────────

export async function handleHuodongxingPoc(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cityParam = url.searchParams.get('city') || '北京';
  const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
  const wantDetail = url.searchParams.get('detail') === '1';

  if (!HUODONGXING_CITIES.includes(cityParam)) {
    return json(
      {
        error: `city "${cityParam}" not supported. Must be one of: ${HUODONGXING_CITIES.join(', ')}`,
      },
      400,
    );
  }
  const city = cityParam as HuodongxingCity;

  const t0 = Date.now();
  const listUrl = listingUrl(city, page);
  const listRes = await fetchText(listUrl);
  if (!listRes.ok) {
    return json({ error: `listing fetch failed: HTTP ${listRes.status}`, url: listUrl }, 502);
  }

  const parsed = parseListing(listRes.body, city);
  const cards = parsed.cards;

  let detail: DetailEnrich | null = null;
  let detailLocation: string | null = null;
  let detailFetchInfo: { url: string; status: number; bytes: number; ms: number } | null = null;
  if (wantDetail && cards.length > 0) {
    const first = cards[0];
    const dUrl = detailUrl(first.event_id);
    const dRes = await fetchText(dUrl);
    detailFetchInfo = { url: dUrl, status: dRes.status, bytes: dRes.bytes, ms: dRes.ms };
    if (dRes.ok) {
      detail = parseDetail(dRes.body);
      if (detail) {
        detailLocation = combineLocation(first.city, detail);
      }
    }
  }

  const fieldStats: Record<string, number> = {};
  if (cards.length > 0) {
    const total = cards.length;
    const has = (pred: (c: EventCard) => boolean) => cards.filter(pred).length;
    fieldStats.cards_total = total;
    fieldStats.has_title = has((c) => !!c.title);
    fieldStats.has_thumbnail = has((c) => !!c.thumbnail);
    fieldStats.has_time_raw = has((c) => !!c.time_raw);
    fieldStats.has_location_raw = has((c) => !!c.location_raw);
    fieldStats.has_city = has((c) => !!c.city);
    fieldStats.has_organizer_name = has((c) => !!c.organizer.name);
    fieldStats.has_organizer_url = has((c) => !!c.organizer.url);
    fieldStats.has_organizer_slug = has((c) => c.organizer.slug !== null);
    fieldStats.has_organizer_id_numeric = has((c) => c.organizer.org_id !== null);
    fieldStats.has_organizer_identity = has(
      (c) => c.organizer.slug !== null || c.organizer.org_id !== null,
    );
    fieldStats.has_organizer_avatar = has((c) => !!c.organizer.avatar_url);
    fieldStats.has_organizer_fans = has((c) => c.organizer.fans !== null);
    fieldStats.organizer_certified_company = has((c) => c.organizer.is_certified_company);
    fieldStats.organizer_vip_gold = has((c) => c.organizer.is_vip_gold);
    fieldStats.online_events = has((c) => c.is_online);
  }

  return json({
    ok: true,
    request: { city, page, wantDetail },
    listing: {
      url: listUrl,
      http_status: listRes.status,
      bytes: listRes.bytes,
      fetch_ms: listRes.ms,
      parsed_count: cards.length,
      is_last_page: parsed.isLastPage,
      field_stats: fieldStats,
      cards: cards.slice(0, 5),
    },
    detail: detailFetchInfo
      ? {
          ...detailFetchInfo,
          parsed: detail
            ? {
                ...detail,
                location_full: detailLocation,
                guests_preview: detail.guests.slice(0, 3),
                guests_count: detail.guests.length,
                ticket_tiers_count: detail.ticket_tiers.length,
              }
            : null,
          parse_ok: detail !== null,
        }
      : null,
    summary: { total_ms: Date.now() - t0 },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

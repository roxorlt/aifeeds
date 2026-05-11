// 活动行 (huodongxing.com) 抓取主入口 — Phase 1 仅 POC，不入库。
//
// Phase 2 此文件会扩展为：
//   - runHuodongxingFetchList(env, batch): cron 抢占调度入口
//   - runHuodongxingDetailEnrich(env, limit): detail 增量 enrich
//   - countHuodongxingDetailPending(env): preempt 决策计数
//
// 当前仅暴露 handleHuodongxingPoc 给 /poc/hdx endpoint。

import type { Env } from '../index';
import {
  HUODONGXING_CITIES,
  HUODONGXING_PRIMARY_CITIES,
  listingUrl,
  detailUrl,
  type HuodongxingCity,
} from './huodongxing/cities';
import { parseListing, type EventCard } from './huodongxing/parser';
import { parseDetail, combineLocation, type DetailEnrich } from './huodongxing/parser-detail';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<{ ok: boolean; status: number; body: string; bytes: number; ms: number }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body, bytes: body.length, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, body: '', bytes: 0, ms: Date.now() - t0 };
  }
}

// ─── POC endpoint ─────────────────────────────────────────────
//
// GET /poc/hdx?city=北京&page=1&detail=1
//
// 参数：
//   city  默认 "北京"，必须在 HUODONGXING_CITIES 内（其它城市站点无聚合页）
//   page  默认 1
//   detail  "1" 时对第一条命中的 event 同步抓 detail 页解析，附在结果里
//
// 返回 JSON 含 timings / parse 结果 / 预算消耗 / 字段抽取统计，便于调参 / 验收 parser。

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

  // 1. 抓列表页
  const listUrl = listingUrl(city, page);
  const listRes = await fetchText(listUrl);
  if (!listRes.ok) {
    return json(
      {
        error: `listing fetch failed: HTTP ${listRes.status}`,
        url: listUrl,
        timings: { total_ms: Date.now() - t0 },
      },
      502,
    );
  }

  const parsed = parseListing(listRes.body);
  const cards = parsed.cards;

  // 2. 可选 detail enrich first card
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

  const totalMs = Date.now() - t0;
  const subreqUsed = wantDetail && detail !== null ? 2 : 1;

  // 3. 字段抽取统计（便于眼校验 parser 完整度）
  const cardFieldStats = aggregateCardStats(cards);

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
      field_stats: cardFieldStats,
      cards: cards.slice(0, 5).map(redactForPoc),  // 先返前 5 条样本（响应不臃肿）
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
    summary: {
      total_ms: totalMs,
      subrequests_used: subreqUsed,
      primary_cities_total: HUODONGXING_PRIMARY_CITIES.length,
      all_cities_total: HUODONGXING_CITIES.length,
    },
  });
}

function redactForPoc(c: EventCard): EventCard {
  // POC 响应直接回所有字段，未来需要时可以脱敏
  return c;
}

function aggregateCardStats(cards: EventCard[]): Record<string, number> {
  if (cards.length === 0) return {};
  const has = (pred: (c: EventCard) => boolean) => cards.filter(pred).length;
  return {
    cards_total: cards.length,
    has_title: has((c) => !!c.title),
    has_thumbnail: has((c) => !!c.thumbnail),
    has_time_raw: has((c) => !!c.time_raw),
    has_location_raw: has((c) => !!c.location_raw),
    has_city: has((c) => !!c.city),
    has_organizer_name: has((c) => !!c.organizer.name),
    has_organizer_url: has((c) => !!c.organizer.url),
    has_organizer_slug: has((c) => c.organizer.slug !== null),
    has_organizer_id_numeric: has((c) => c.organizer.org_id !== null),
    has_organizer_identity: has((c) => c.organizer.slug !== null || c.organizer.org_id !== null),
    has_organizer_avatar: has((c) => !!c.organizer.avatar_url),
    has_organizer_fans: has((c) => c.organizer.fans !== null),
    organizer_certified_company: has((c) => c.organizer.is_certified_company),
    organizer_vip_gold: has((c) => c.organizer.is_vip_gold),
    online_events: has((c) => c.is_online),
  };
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

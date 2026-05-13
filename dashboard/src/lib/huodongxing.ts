// Huodongxing-source 共享 helper：状态判定、时间/地点/价格格式化。
// Card / Drawer / Share 海报都依赖这一层；逻辑集中，避免三处各算一次差异。

import type { HuodongxingTicketTier, ItemExtra } from "../types";

export type EventState = "live" | "soon" | "ended" | "unenriched";

/**
 * 判定活动状态。基于 extra.start_time / end_time / status / detail_enriched_at。
 *
 * 优先级：
 *   1. detail 未 enrich 且没有 time_raw 解析出的时间 → "unenriched"
 *      （unenriched 不代表 ended，detail 抓回来后会回到正常状态）
 *   2. status === "historical" 或 end_time < now → "ended"
 *   3. now ∈ [start_time, end_time] → "live"
 *   4. now < start_time → "soon"
 *   5. 兜底 → "soon"
 *
 * 注：unenriched 状态下卡片显示 time_raw 字符串（"明天 19:30"）做兜底，
 * 不参与 live/soon/ended 三态判定（避免错把"明天"算成 ended）。
 */
export function getEventState(extra: ItemExtra | null, nowMs: number = Date.now()): EventState {
  if (!extra) return "unenriched";
  const enrichedAt = extra.detail_enriched_at;
  if (!enrichedAt && !extra.start_time && !extra.end_time) {
    return "unenriched";
  }
  if (extra.status === "historical") return "ended";

  const start = extra.start_time ? Date.parse(extra.start_time) : NaN;
  const end = extra.end_time ? Date.parse(extra.end_time) : NaN;

  if (Number.isFinite(end) && end < nowMs) return "ended";
  if (Number.isFinite(start) && Number.isFinite(end) && start <= nowMs && nowMs < end) return "live";
  if (Number.isFinite(start) && start <= nowMs && !Number.isFinite(end)) {
    // 有 start 没 end：start 起 24h 内视为 live，之后视为 ended
    if (nowMs - start < 24 * 3600 * 1000) return "live";
    return "ended";
  }
  if (Number.isFinite(start) && nowMs < start) return "soon";
  return "soon";
}

/**
 * Card meta 第一段：时间字符串。
 * - enriched + start_short：直接用站点 SSR 文本（"05/21 14:30"）
 * - enriched 无 start_short：从 start_time ISO 派生 "MM/DD 周X HH:mm"
 * - 未 enrich：用 time_raw 原文（"明天 19:30" / "后天 10:00"）
 * - 都没有：返 null
 */
export function formatEventTime(extra: ItemExtra | null): string | null {
  if (!extra) return null;
  if (extra.start_short) return extra.start_short;
  if (extra.start_time) {
    const d = new Date(extra.start_time);
    if (!Number.isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const w = "日一二三四五六"[d.getDay()];
      const hh = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      return `${mm}/${dd} 周${w} ${hh}:${mi}`;
    }
  }
  if (extra.time_raw) return extra.time_raw;
  return null;
}

/**
 * Card meta 第二段：地点字符串。
 * - is_online → "线上活动"
 * - enriched 有 city + district：`{city} · {district}`（district == city 时只显 city）
 * - 未 enrich：用 location_raw 原文
 */
export function formatEventLocation(extra: ItemExtra | null): string | null {
  if (!extra) return null;
  if (extra.is_online) return "线上活动";
  if (extra.city) {
    const d = extra.district;
    if (d && d !== extra.city) return `${extra.city} · ${d}`;
    return extra.city;
  }
  if (extra.location_raw) return extra.location_raw;
  return null;
}

/**
 * Card meta 第三段：价格字符串。
 * - is_free === true：返 "免费"
 * - ticket_tiers 取最低价：`¥{min}` 或 `¥{min} 起`（多档时加"起"）
 * - 未 enrich 或无票档信息：返 null（卡片这段省略，drawer 走更详细的票档显示）
 */
export function formatEventPrice(extra: ItemExtra | null): string | null {
  if (!extra) return null;
  if (extra.is_free === true) return "免费";
  const tiers = extra.ticket_tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  // 提取数值价格，0 算免费占位（个别票档 price_str 是"免费"但 price=0）
  const prices = tiers
    .map((t: HuodongxingTicketTier) => t.price)
    .filter((p): p is number => typeof p === "number");
  if (prices.length === 0) {
    // 所有 price 都不是数字 → 用第一档 price_str
    return tiers[0]?.price_str ?? null;
  }
  const min = Math.min(...prices);
  if (min === 0) return "免费";
  const suffix = prices.length > 1 ? " 起" : "";
  return `¥${min}${suffix}`;
}

/**
 * Card meta 第四段：报名数 / 容量。
 * - registered + max：`{r}/{m}`（drawer KPI 用这个；card 在容量小时显示）
 * - 只有 registered：`报名 {r}`（带千分位，>999 用 1.2k）
 * - 都没有：null
 */
export function formatEventRegistered(
  registered?: number,
  maxInstance?: number,
): string | null {
  if (typeof registered !== "number") return null;
  if (typeof maxInstance === "number" && maxInstance > 0 && maxInstance <= 999) {
    // 小活动直接展示 N/M（设计稿 Card 4 演示）
    return `${registered} / ${maxInstance}`;
  }
  if (registered >= 10000) return `报名 ${(registered / 10000).toFixed(1)}万`;
  if (registered >= 1000) return `报名 ${(registered / 1000).toFixed(1)}k`;
  return `报名 ${registered}`;
}

/**
 * 主办方粉丝数显示：
 *   < 1k → 原数字
 *   1k-1万 → "8,124"（千分位）
 *   ≥ 1万 → "3.2 万"
 */
export function formatOrganizerFans(fans?: number): string | null {
  if (typeof fans !== "number" || fans < 0) return null;
  if (fans >= 10000) return `${(fans / 10000).toFixed(1)} 万`;
  if (fans >= 1000) return fans.toLocaleString("en-US");
  return String(fans);
}

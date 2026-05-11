// 活动行 24 个官方城市 — 通过 changecity 页面枚举确认。
// 6 个核心城市站点另有子域名形式 (bj/sh/gz/sz/hz/cd.huodongxing.com)，但 18 个次级
// 城市只能用 ?city= 形式，工程统一用 ?city=<name>（design doc §1 已 sign-off）。
//
// 来源：https://www.huodongxing.com/changecity（2026-05-11 reconnaissance）

export const HUODONGXING_CITIES: readonly string[] = [
  // 核心 6（默认显示在前端 chip 第一行）
  '北京', '上海', '广州', '深圳', '杭州', '成都',
  // 次级 18（前端 "更多" 展开）
  '长沙', '南京', '重庆', '苏州', '西安', '郑州',
  '厦门', '天津', '宁波', '青岛', '东莞', '佛山',
  '济南', '珠海', '合肥', '福州', '石家庄', '昆明',
] as const;

export type HuodongxingCity = (typeof HUODONGXING_CITIES)[number];

export const HUODONGXING_PRIMARY_CITIES: readonly HuodongxingCity[] = [
  '北京', '上海', '广州', '深圳', '杭州', '成都',
] as const;

// ─── URL 拼装 ──────────────────────────────────────────────────

const HUODONGXING_BASE = 'https://www.huodongxing.com';

/**
 * 构造列表页 URL。
 * city 必须是 HUODONGXING_CITIES 中之一（其它城市站点无聚合页，无意义）。
 * page 从 1 开始；page > 末页时站点返回 hd-empty-list 空态。
 */
export function listingUrl(city: HuodongxingCity, page: number = 1): string {
  const params = new URLSearchParams({
    tag: 'AI',
    city,
    orderby: 'o',
    page: String(page),
  });
  return `${HUODONGXING_BASE}/events?${params.toString()}`;
}

/**
 * 构造单个 event 详情页 URL。event_id 是站点原始数字 ID（如 "5859894940100"）。
 */
export function detailUrl(eventId: string): string {
  return `${HUODONGXING_BASE}/event/${encodeURIComponent(eventId)}`;
}

/**
 * Item ID convention: huodongxing:<event_id>，与其它 source 一致。
 */
export function itemId(eventId: string): string {
  return `huodongxing:${eventId}`;
}

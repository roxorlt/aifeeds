import type {
  CardImageVariant,
  HomeFeedResponse,
  Item,
  ItemExtra,
  SourceType,
} from "../types";

const HOME_SOURCES = new Set<SourceType>([
  "x_list",
  "blog",
  "podcast",
  "github",
  "product_hunt",
  "hf_paper",
  "huodongxing",
  "clawhub",
  "youtube",
]);

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  x_list: "X List",
  blog: "官方新闻",
  podcast: "AI 播客",
  github: "GitHub",
  product_hunt: "Product Hunt",
  hf_paper: "AI 论文",
  huodongxing: "AI 活动",
  clawhub: "ClawHub",
  youtube: "YouTube",
};

export type HomeCardImage = Readonly<{
  src: string;
  width: number;
  height: number;
  alt: string;
}>;

export type HomeCardModel = Readonly<{
  sourceLabel: string;
  title: string;
  summary: string;
  meta: string;
  image: HomeCardImage | null;
}>;

type FetchHomeFeedOptions = Readonly<{
  cursor: string | null;
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && HOME_SOURCES.has(value as SourceType);
}

function isHomeItem(value: unknown): value is Item {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string"
    && value.id.length > 0
    && value.id.length <= 512
    && isSourceType(value.source_type)
    && typeof value.source_id === "string"
    && value.source_id.length > 0
    && value.source_id.length <= 512
    && typeof value.scraped_at === "string"
    && value.scraped_at.length > 0
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isHomeFeedResponse(value: unknown): value is HomeFeedResponse {
  if (!isRecord(value) || value.view_mode !== "waterfall") return false;
  if (value.ranking_version !== 1 && value.ranking_version !== 2) return false;
  if (!Array.isArray(value.items) || value.items.length > 48 || !value.items.every(isHomeItem)) {
    return false;
  }
  return (
    isNullableString(value.next_cursor)
    && typeof value.has_more === "boolean"
    && typeof value.generated_at === "string"
  );
}

export function parseInitialHomeFeed(rawJson: string): HomeFeedResponse {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const value: unknown = isRecord(parsed) && parsed.ranking_version === undefined
      ? { ...parsed, ranking_version: 1 }
      : parsed;
    if (!isHomeFeedResponse(value)) throw new Error("shape");
    return value;
  } catch {
    throw new Error("Invalid initial home feed");
  }
}

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function itemExtra(item: Item): ItemExtra {
  return isRecord(item.extra) ? item.extra as ItemExtra : {};
}

function safeR2Url(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  if (/^\/r\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value)) return value;
  try {
    const url = new URL(value);
    const isFirstParty = (
      url.protocol === "https:"
      && (
        url.hostname === "api.ai-feeds.com"
        || url.hostname === "staging-api.ai-feeds.com"
        || url.hostname === "perf-staging.ai-feeds.com"
      )
    );
    return isFirstParty && url.pathname.startsWith("/r/") ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeVariant(value: unknown): CardImageVariant | null {
  if (!isRecord(value)) return null;
  const url = safeR2Url(value.url);
  const width = value.width;
  const height = value.height;
  if (
    !url
    || value.format !== "webp"
    || typeof width !== "number"
    || !Number.isFinite(width)
    || width < 120
    || width > 1_600
    || typeof height !== "number"
    || !Number.isFinite(height)
    || height < 80
    || height > 1_600
  ) return null;
  return { url, width, height, format: "webp" };
}

function firstVariantGroup(item: Item): unknown[] {
  const extra = itemExtra(item);
  const mediaGroups = Array.isArray(item.media)
    ? item.media.flatMap((entry) => (
      Array.isArray(entry.card_variants) ? [entry.card_variants] : []
    ))
    : [];
  return [
    extra.cover_variants,
    extra.cover_image_variants,
    extra.card_thumbnail_variants,
    ...mediaGroups,
  ].filter(Array.isArray);
}

function pickSafeImage(item: Item, alt: string): HomeCardImage | null {
  for (const group of firstVariantGroup(item)) {
    const variants = (group as unknown[])
      .map(safeVariant)
      .filter((variant): variant is CardImageVariant => variant !== null)
      .sort((a, b) => a.width - b.width);
    if (variants.length === 0) continue;
    const selected = variants.find((variant) => variant.width >= 640) ?? variants.at(-1);
    if (!selected?.height) continue;
    return {
      src: selected.url,
      width: selected.width,
      height: selected.height,
      alt,
    };
  }
  return null;
}

function homeTitle(item: Item, extra: ItemExtra): string {
  return compactText(
    extra.title_zh
    ?? item.title
    ?? item.content_translated
    ?? item.content
    ?? `${SOURCE_LABELS[item.source_type]} 动态`,
    120,
  );
}

function homeSummary(item: Item, extra: ItemExtra): string {
  return compactText(
    extra.excerpt_zh
    ?? extra.ai_summary_zh
    ?? extra.ai_summary
    ?? extra.summary_translated
    ?? extra.excerpt
    ?? item.content_translated
    ?? item.content
    ?? "",
    280,
  );
}

function homeMeta(item: Item): string {
  const rawDate = item.published_at ?? item.scraped_at;
  const normalized = rawDate.includes("T")
    ? rawDate
    : rawDate.replace(" ", "T");
  const withTimeZone = /Z$|[+-]\d{2}:?\d{2}$/iu.test(normalized)
    ? normalized
    : /^\d{4}-\d{2}-\d{2}$/u.test(normalized)
      ? `${normalized}T00:00:00Z`
      : `${normalized}Z`;
  const parsed = Date.parse(withTimeZone);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

export function getHomeCardModel(item: Item): HomeCardModel {
  const extra = itemExtra(item);
  const title = homeTitle(item, extra);
  return {
    sourceLabel: SOURCE_LABELS[item.source_type] ?? item.source_type,
    title,
    summary: homeSummary(item, extra),
    meta: homeMeta(item),
    image: pickSafeImage(item, title),
  };
}

export function buildHomeFeedClientPath(cursor: string | null, limit = 24): string {
  const boundedLimit = Math.min(48, Math.max(12, Math.trunc(limit) || 24));
  const search = new URLSearchParams({ limit: String(boundedLimit) });
  if (cursor) search.set("cursor", cursor);
  return `/_home/feed?${search.toString()}`;
}

export async function fetchHomeFeedPage({
  cursor,
  limit = 24,
  signal,
  fetchImpl = fetch,
}: FetchHomeFeedOptions): Promise<HomeFeedResponse> {
  const response = await fetchImpl(buildHomeFeedClientPath(cursor, limit), {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Home feed request failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!isHomeFeedResponse(value)) throw new Error("Invalid home feed response");
  return value;
}

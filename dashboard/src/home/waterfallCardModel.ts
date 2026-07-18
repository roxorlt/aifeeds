import type { Item, ItemExtra } from "../types";
import {
  getHomeCardModel,
  type HomeCardImage,
} from "./homeData.ts";

export type WaterfallMetric = Readonly<{
  label: string;
  value: string;
}>;

export type WaterfallCardModel = Readonly<{
  sourceLabel: string;
  identity: string;
  secondaryIdentity: string;
  title: string | null;
  summary: string;
  meta: string;
  image: HomeCardImage | null;
  mediaPosition: "before_text" | "after_text";
  metrics: WaterfallMetric[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extraFor(item: Item): ItemExtra {
  return parseRecord(item.extra) as ItemExtra;
}

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function numberMetric(metrics: Record<string, unknown>, key: string): number | null {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatCompactNumber(value: number): string {
  const format = (scaled: number, suffix: string) => (
    `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/u, "")}${suffix}`
  );
  if (value >= 1_000_000) return format(value / 1_000_000, "M");
  if (value >= 1_000) return format(value / 1_000, "K");
  return String(Math.round(value));
}

function metric(
  metrics: Record<string, unknown>,
  key: string,
  label: string,
): WaterfallMetric | null {
  const value = numberMetric(metrics, key);
  return value === null ? null : { label, value: formatCompactNumber(value) };
}

function firstMetrics(values: Array<WaterfallMetric | null>): WaterfallMetric[] {
  return values.filter((value): value is WaterfallMetric => value !== null).slice(0, 2);
}

function identityFor(item: Item, extra: ItemExtra, sourceLabel: string): string {
  switch (item.source_type) {
    case "x_list":
      return compactText(item.author ?? item.handle, 48) || "X";
    case "github":
      return compactText(item.source_id, 72) || "GitHub";
    case "product_hunt":
      return "Product Hunt";
    case "hf_paper":
      return extra.arxiv_id ? `arXiv ${extra.arxiv_id}` : "Hugging Face Papers";
    case "blog":
      return compactText(
        extra.source_company ?? extra.publisher?.name ?? extra.blog_name,
        48,
      ) || sourceLabel;
    case "podcast":
      return compactText(
        extra.show_name ?? extra.publisher?.name ?? extra.source_company,
        48,
      ) || sourceLabel;
    case "clawhub":
      return compactText(item.author, 48) || "ClawHub";
    case "huodongxing":
      return compactText(extra.organizer?.name, 48) || compactText(extra.city, 24) || sourceLabel;
    case "youtube":
      return compactText(item.author ?? item.handle, 48) || "YouTube";
    default:
      return sourceLabel;
  }
}

function secondaryIdentityFor(item: Item, extra: ItemExtra): string {
  switch (item.source_type) {
    case "x_list":
    case "youtube":
      return compactText(item.handle, 48);
    case "github":
      return compactText(extra.language, 24);
    case "hf_paper":
      return "每日论文";
    case "blog":
      return compactText(extra.blog_name, 48);
    case "podcast":
      return typeof extra.episode_no === "number" ? `第 ${extra.episode_no} 期` : "";
    case "huodongxing":
      return compactText(extra.city, 24);
    default:
      return "";
  }
}

function metricsFor(item: Item, extra: ItemExtra): WaterfallMetric[] {
  const metrics = parseRecord(item.metrics);
  switch (item.source_type) {
    case "x_list":
      return firstMetrics([
        metric(metrics, "likes", "赞"),
        metric(metrics, "replies", "回复"),
        metric(metrics, "views", "浏览"),
      ]);
    case "github":
      return firstMetrics([
        metric(metrics, "today_stars", "今日 ★"),
        metric(metrics, "stars", "★"),
        metric(metrics, "forks", "Fork"),
      ]);
    case "product_hunt":
      return firstMetrics([
        metric(metrics, "votes", "▲"),
        metric(metrics, "comments", "评论"),
      ]);
    case "hf_paper":
      return firstMetrics([
        metric(metrics, "upvotes", "赞同"),
        metric(metrics, "num_comments", "讨论"),
        metric(metrics, "github_stars", "GitHub ★"),
      ]);
    case "blog": {
      const minutes = typeof extra.reading_minutes === "number" && extra.reading_minutes > 0
        ? Math.round(extra.reading_minutes)
        : null;
      return minutes === null ? [] : [{ label: "阅读", value: `${minutes} 分钟` }];
    }
    case "podcast": {
      const seconds = typeof extra.duration_sec === "number" && extra.duration_sec > 0
        ? extra.duration_sec
        : null;
      return seconds === null
        ? []
        : [{ label: "时长", value: `${Math.max(1, Math.round(seconds / 60))} 分钟` }];
    }
    case "clawhub":
      return firstMetrics([
        metric(metrics, "stars", "★"),
        metric(metrics, "downloads", "下载"),
        metric(metrics, "installsCurrent", "安装"),
      ]);
    case "huodongxing":
      return firstMetrics([
        metric(metrics, "registered_count", "报名"),
        metric(metrics, "visit_number", "浏览"),
      ]);
    case "youtube":
      return firstMetrics([
        metric(metrics, "views", "播放"),
        metric(metrics, "likes", "赞"),
      ]);
    default:
      return [];
  }
}

export function getWaterfallCardModel(item: Item): WaterfallCardModel {
  const base = getHomeCardModel(item);
  const extra = extraFor(item);
  const isDynamic = item.source_type === "x_list";
  return {
    sourceLabel: base.sourceLabel,
    identity: identityFor(item, extra, base.sourceLabel),
    secondaryIdentity: secondaryIdentityFor(item, extra),
    title: isDynamic ? null : base.title,
    summary: isDynamic
      ? compactText(item.content_translated ?? item.content, 280)
      : base.summary,
    meta: base.meta,
    image: base.image,
    mediaPosition: isDynamic ? "after_text" : "before_text",
    metrics: metricsFor(item, extra),
  };
}

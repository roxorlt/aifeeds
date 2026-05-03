// Product Hunt feed card.
// 视觉基线对齐 TweetCard / GithubCard，按 docs/frontend-ux-guidelines.md：
//   - 卡片：px-4 py-3，hover:bg-neutral-50/60，border-b 分隔，无 shadow
//   - 头像：h-10 w-10 rounded-md（产品 logo 是品牌图标，方形圆角更合适，
//     X tweet / GH owner 是头像用 rounded-full）
//   - 标题：text-[15px] font-bold
//   - 正文：text-[15px] leading-[1.45]
//   - meta：text-[13px] text-neutral-500
//   - chip：rounded-full bg-neutral-100 text-neutral-700（不再 14 个色）

import type { Item, ItemExtra, MediaItem, PhMetrics } from "../types";
import { formatCompact, ordinal, parseJsonField } from "../lib/utils";
import { useDrawer } from "../lib/drawer";
import { resolveAssetUrl } from "../lib/asset";

function parseMedia(raw: Item["media"]): MediaItem[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

interface Props {
  item: Item;
}

export function PhCard({ item }: Props) {
  const drawer = useDrawer();
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<PhMetrics>(item.metrics) ?? ({} as PhMetrics);
  const media = parseMedia(item.media);

  const name = item.title || "?";
  const tagline = item.content_translated || item.content || "";
  const dailyRank = (extra as { daily_rank?: number }).daily_rank;
  const launchDate = extra.launch_date_pt || "";
  const dateMd = launchDate ? launchDate.slice(5) : ""; // "MM-DD"
  const aiCategoryRaw = (extra.ai_category as string) || "";
  // 转 "ai_code_editor" → "AI Code Editor"
  const aiCategoryLabel = aiCategoryRaw
    ? aiCategoryRaw.replace(/^ai_/, "AI ").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Ai /, "AI ")
    : "";

  const logo = media.find((m) => (m as MediaItem & { role?: string }).role === "logo");
  const logoUrl = logo?.url ? resolveAssetUrl(logo.url) : "";

  const votes = metrics.votes;
  const comments = metrics.comments;
  const makerHandle = item.handle || "";

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex gap-3">
        {/* Logo (product brand icon — rounded-md 方形圆角，区分人脸头像 rounded-full) */}
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={name}
            className="h-10 w-10 shrink-0 rounded-md bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-md bg-neutral-200" />
        )}

        <div className="min-w-0 flex-1">
          {/* Title row：name + 行内 daily rank（克制风格，不在最显眼位置） */}
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[15px] font-bold leading-tight text-neutral-900">
              {name}
            </span>
            {dailyRank !== undefined && (
              <span
                className="shrink-0 text-[13px] font-medium text-neutral-500 tabular-nums"
                title={`PH 当日榜第 ${dailyRank} 名`}
              >
                · #{dailyRank}
              </span>
            )}
          </div>

          {/* Meta：date + category（neutral chip，不彩） */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-neutral-500">
            {dateMd && <span className="tabular-nums">{dateMd} PT</span>}
            {dateMd && aiCategoryLabel && <span className="text-neutral-400">·</span>}
            {aiCategoryLabel && (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                {aiCategoryLabel}
              </span>
            )}
          </div>

          {/* Tagline */}
          {tagline && (
            <p className="mt-1 line-clamp-3 text-[15px] leading-[1.45] text-neutral-900 break-words">
              {tagline}
            </p>
          )}

          {/* Footer metrics (neutral, flat) */}
          <div className="mt-2 flex items-center gap-x-3 gap-y-0.5 text-[13px] text-neutral-500">
            {votes !== undefined && (
              <span className="inline-flex items-center gap-1" aria-label="votes">
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l5 6H3l5-6z"/></svg>
                <span className="tabular-nums">{formatCompact(votes)}</span>
              </span>
            )}
            {comments !== undefined && (
              <span className="inline-flex items-center gap-1" aria-label="comments">
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H3a1 1 0 01-1-1V5a1 1 0 011-1z"/></svg>
                <span className="tabular-nums">{formatCompact(comments)}</span>
              </span>
            )}
            {makerHandle && (
              <span className="truncate text-neutral-500">by @{makerHandle}</span>
            )}
            {dailyRank !== undefined && (
              <span className="ml-auto text-[11px] text-neutral-400" title={ordinal(dailyRank)}>
                {ordinal(dailyRank)}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

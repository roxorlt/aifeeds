// Product Hunt feed card.
// 视觉基线对齐 TweetCard / GithubCard，按 docs/frontend-ux-guidelines.md：
//   - 卡片：px-4 py-3，hover:bg-neutral-50/60，border-b 分隔，无 shadow
//   - 头像：h-10 w-10 rounded-md（产品 logo 是品牌图标，方形圆角更合适，
//     X tweet / GH owner 是头像用 rounded-full）
//   - 标题：text-[15px] font-bold
//   - 正文：text-[15px] leading-[1.45]，line-clamp 4 行
//   - meta（第二行）：日期(无 PT 后缀) / #排名 / 分类标签（彩色 chip）
//   - footer：互动数据 + makers 头像（最多 3）+ "by @first 等 N 人"

import type { Item, ItemExtra, MediaItem, PhMetrics } from "../types";
import { formatCompact, parseJsonField } from "../lib/utils";
import { useDrawer } from "../lib/drawer";
import { resolveAssetUrl } from "../lib/asset";

// PH 分类彩色 chip 风格，跟 GithubCard 同款语义（同色系区分品类）
const PH_CATEGORY_STYLE: Record<string, string> = {
  ai_agent: "bg-violet-100 text-violet-700",
  ai_code_editor: "bg-blue-100 text-blue-700",
  ai_image_gen: "bg-rose-100 text-rose-700",
  ai_audio: "bg-amber-100 text-amber-700",
  ai_voice_agent: "bg-orange-100 text-orange-700",
  ai_data_analysis: "bg-emerald-100 text-emerald-700",
  ai_other: "bg-neutral-100 text-neutral-700",
};

function categoryStyle(cat: string | undefined): string {
  if (!cat) return "bg-neutral-100 text-neutral-700";
  return PH_CATEGORY_STYLE[cat] || "bg-neutral-100 text-neutral-700";
}

function categoryLabel(cat: string): string {
  // ai_code_editor → AI Code Editor
  return cat.replace(/^ai_/, "AI ").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Ai /, "AI ");
}

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

interface Maker {
  name?: string;
  handle?: string;
  avatar_url?: string;
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
  const dateMd = launchDate ? launchDate.slice(5) : ""; // "MM-DD"，无 PT 后缀
  const aiCategoryRaw = (extra.ai_category as string) || "";
  const aiCategoryLabel = aiCategoryRaw ? categoryLabel(aiCategoryRaw) : "";

  const logo = media.find((m) => (m as MediaItem & { role?: string }).role === "logo");
  const logoUrl = logo?.url ? resolveAssetUrl(logo.url) : "";

  const votes = metrics.votes;
  const comments = metrics.comments;

  // makers：取前 3 头像，+ 总数文本
  const makers: Maker[] = (extra.makers as Maker[] | undefined) || [];
  const visibleMakers = makers.slice(0, 3);
  const firstHandle = makers[0]?.handle || item.handle || "";

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex gap-3">
        {/* Logo (产品品牌图标，rounded-md 方形圆角) */}
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
          {/* Title row：单纯产品名（rank 挪到第二行避免重复） */}
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[15px] font-bold leading-tight text-neutral-900">
              {name}
            </span>
          </div>

          {/* Meta（第二行）：日期 / #排名 / 分类标签（彩色 chip） */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-neutral-500">
            {dateMd && <span className="tabular-nums">{dateMd}</span>}
            {dateMd && dailyRank !== undefined && <span className="text-neutral-400">·</span>}
            {dailyRank !== undefined && (
              <span className="tabular-nums" title={`PH 当日榜第 ${dailyRank} 名`}>
                #{dailyRank}
              </span>
            )}
            {(dateMd || dailyRank !== undefined) && aiCategoryLabel && (
              <span className="text-neutral-400">·</span>
            )}
            {aiCategoryLabel && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${categoryStyle(aiCategoryRaw)}`}>
                {aiCategoryLabel}
              </span>
            )}
          </div>

          {/* Tagline 正文 — 4 行 */}
          {tagline && (
            <p className="mt-1 line-clamp-4 text-[15px] leading-[1.45] text-neutral-900 break-words">
              {tagline}
            </p>
          )}

          {/* Footer：左 votes/comments，右 makers 头像 + by @xxx 等 N 人 */}
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
            {/* makers 右对齐：最多 3 个头像 + 文字。
                ml-auto 把整组推到右；min-w-0 + 内层 truncate 让 by @ 文字在窄屏
                上能省略号收尾，不会再溢出到卡片外。 */}
            {(visibleMakers.length > 0 || firstHandle) && (
              <span className="ml-auto flex min-w-0 items-center gap-1.5 text-neutral-500">
                {visibleMakers.length > 0 && (
                  <span className="flex shrink-0 -space-x-1.5">
                    {visibleMakers.map((m, i) => {
                      const src = resolveAssetUrl(m.avatar_url);
                      return src ? (
                        <img
                          key={m.handle || i}
                          src={src}
                          alt={m.name || m.handle || ""}
                          className="h-5 w-5 rounded-full border border-white bg-neutral-200 object-cover"
                          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                        />
                      ) : (
                        <span
                          key={m.handle || i}
                          className="h-5 w-5 rounded-full border border-white bg-neutral-200"
                        />
                      );
                    })}
                  </span>
                )}
                {firstHandle && (
                  <span className="min-w-0 truncate text-[13px]">
                    by @{firstHandle}{makers.length > 1 ? ` 等 ${makers.length} 人` : ""}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

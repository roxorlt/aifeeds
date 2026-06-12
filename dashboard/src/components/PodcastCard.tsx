// Podcast (AI 播客单集) feed card.
//
// 设计：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §10.2
// 视觉家族：TweetCard 家族 —— 左 72×72 方形圆角封面（非圆头像）+ 居中 play 三角
// 叠加，右内容列。token 对齐 docs/frontend-ux-guidelines.md：
//   - 卡片 px-4 py-3 hover:bg-neutral-50/60 border-b 无 shadow 无 rounded
//   - byline：节目名 · 时间 ·（A 档）[有文字稿] chip
//   - 单集标题 text-[15px] font-bold（2 行 clamp）/ ELI25 shownotes 摘要 text-[13px]（2 行）
//   - 无互动数行（RSS 无播放量），用「单集时长」当 meta 替代
//   - play 三角复用 PhCard 的 <path d="M8 5v14l11-7z"/>，严禁 ▶ emoji
//
// 注：blog/podcast 无 metrics，不挂 useImpressionRefresh（无 refresh-metrics cron）。

import { useState } from "react";
import type { Item, ItemExtra } from "../types";
import { parseJsonField, proxyImg, timeAgo } from "../lib/utils";
import { useDrawer } from "../lib/drawer";
import { IconClock } from "./icons";

interface Props {
  item: Item;
  // 首屏前几张卡(Feed 传入):封面图 eager + fetchPriority=high,LCP 优化
  eager?: boolean;
}

// 封面 fallback monogram 取色（按节目名 hash）+ 首字母，零网络永远可渲染。
const MONO_PALETTE = [
  "#0f766e", "#7c3aed", "#b45309", "#be123c", "#1d4ed8",
  "#0d9488", "#c2410c", "#4f46e5", "#0369a1", "#9333ea",
];

function monoColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return MONO_PALETTE[h % MONO_PALETTE.length];
}

function monoLetter(name: string): string {
  const ch = (name || "?").trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

// 单集时长 sec → H:MM:SS / M:SS（tabular-nums 展示）。
function formatDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// play 实心三角（复用 PhCard 的 path）—— 居中叠加在封面上，pointer-events-none。
function PlayTriangle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function PodcastCard({ item, eager }: Props) {
  const drawer = useDrawer();
  const [coverFailed, setCoverFailed] = useState(false);

  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);

  const showName = extra.show_name || extra.source_company || item.author || "";
  // 单集标题优先中译；ELI25 shownotes 摘要优先 ai_summary_zh（§8.4.A）。
  const title = extra.title_zh || item.title || "";
  const summary =
    extra.ai_summary_zh ||
    extra.shownotes_zh ||
    extra.shownotes ||
    item.content_translated ||
    item.content ||
    "";

  const time = timeAgo(item.published_at);
  const duration = formatDuration(extra.duration_sec);

  const coverImage = extra.cover_image || "";

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex gap-3">
        {/* 左：72×72 方形圆角封面 + 居中 play 三角叠加 */}
        <div className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-xl bg-neutral-100">
          {coverImage && !coverFailed ? (
            <img
              src={proxyImg(coverImage, 200)}
              alt=""
              loading={eager ? "eager" : "lazy"}
              fetchPriority={eager ? "high" : undefined}
              decoding="async"
              className="h-full w-full object-cover"
              onError={() => setCoverFailed(true)}
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-[22px] font-bold text-white"
              style={{ background: monoColor(showName || "podcast") }}
              aria-hidden="true"
            >
              {monoLetter(showName)}
            </div>
          )}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white">
              <PlayTriangle className="ml-0.5 h-4 w-4" />
            </span>
          </span>
        </div>

        {/* 右：byline / 标题 / 摘要 / 时长 */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500">
            {showName && (
              <span className="truncate font-medium text-neutral-700">{showName}</span>
            )}
            {time && (
              <>
                <span className="shrink-0 text-neutral-400">·</span>
                <span className="shrink-0 whitespace-nowrap">{time}</span>
              </>
            )}
          </div>

          <h3 className="mt-0.5 line-clamp-2 text-[15px] font-bold leading-tight text-neutral-900 break-words">
            {title}
          </h3>

          {summary && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-[1.5] text-neutral-600 break-words">
              {summary}
            </p>
          )}

          {duration && (
            <div className="mt-2 flex items-center gap-1 text-[13px] text-neutral-500">
              <IconClock className="h-3.5 w-3.5" />
              <span className="tabular-nums">{duration}</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

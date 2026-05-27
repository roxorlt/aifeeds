// Product Hunt feed card.
// 视觉基线对齐 TweetCard / GithubCard，按 docs/frontend-ux-guidelines.md：
//   - 卡片：px-4 py-3，hover:bg-neutral-50/60，border-b 分隔，无 shadow
//   - 头像：h-10 w-10 rounded-md（产品 logo 是品牌图标，方形圆角更合适，
//     X tweet / GH owner 是头像用 rounded-full）
//   - 标题：text-[15px] font-bold
//   - 正文：text-[15px] leading-[1.45]，line-clamp 4 行
//   - meta（第二行）：日期(无 PT 后缀) / #排名 / 分类标签（彩色 chip）
//   - footer：互动数据 + makers 头像（最多 3）+ "by @first 等 N 人"

import { useState } from "react";
import type { Item, ItemExtra, MediaItem, PhMetrics } from "../types";
import { formatCompact, parseJsonField, proxyImg } from "../lib/utils";
import { smartTruncate } from "../lib/truncate";
import { useDrawer } from "../lib/drawer";
import { useImpressionRefresh } from "../lib/impressionRefresh";
import { resolveAssetUrl } from "../lib/asset";

// 选 PH cover：第一张非 logo 的 image，没有就用 video poster（YouTube 推 maxresdefault）。
// 同 worker share/handlers.ts:492-515 的选取逻辑，保证流内 cover 跟分享海报 cover 一致。
function selectPhCover(media: MediaItem[]): { url: string; isVideo: boolean } | null {
  // 先 image (排除 logo)
  for (const m of media) {
    const role = (m as MediaItem & { role?: string }).role;
    if (m && m.type === "image" && role !== "logo" && typeof m.url === "string") {
      return { url: m.url, isVideo: false };
    }
  }
  // 再 video poster
  for (const m of media) {
    if (m && m.type === "video") {
      const mm = m as MediaItem & { poster?: string; video_id?: string; platform?: string };
      let poster = typeof mm.poster === "string" ? mm.poster : "";
      if (!poster && mm.platform === "youtube" && mm.video_id) {
        poster = `https://img.youtube.com/vi/${mm.video_id}/maxresdefault.jpg`;
      }
      if (poster) return { url: poster, isVideo: true };
    }
  }
  return null;
}

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
  const [coverFailed, setCoverFailed] = useState(false);
  // onLoad 后检测真实 natural dims（同 GithubCard / worker share/handlers.ts 门控）
  const [coverRejected, setCoverRejected] = useState(false);
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<PhMetrics>(item.metrics) ?? ({} as PhMetrics);
  const media = parseMedia(item.media);
  const cover = selectPhCover(media);

  const name = item.title || "?";
  // 正文优先用 AI 解读（跟 GithubCard 一致 — feed 卡片用 ai_summary 信息
  // 密度更高），缺失时退到 PH 原始 tagline 翻译/原文。drawer 里 ai_summary
  // 作为独立 section 全文展示，卡片用它当 4 行预览。
  const aiSummary = (extra.ai_summary as string) || "";
  const tagline = aiSummary || item.content_translated || item.content || "";
  // display_rank: 后端 ROW_NUMBER 给同日内连续编号 1,2,3...N（绕过 PH 自身 displayRank 跳号/重复）。
  // daily_rank: PH API 原始值（保留作 tooltip 调试）。优先用 display_rank 显示。
  const ex = extra as { daily_rank?: number; display_rank?: number };
  const displayRank = ex.display_rank ?? ex.daily_rank;
  const phRawRank = ex.daily_rank;
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

  // BE §5b: 视口停留 500ms 弱触发 metrics refresh
  const refreshRef = useImpressionRefresh(item.id);

  return (
    <article
      ref={refreshRef}
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      {/* 头部块：logo + (title + meta)，紧凑高度。
          正文 / footer 跨整张卡宽（不再缩进到 logo 右）让窄屏可读性更好；
          视觉上跟 X 推文风格区分（X 是严格左对齐，PH 是 YouTube 卡片风格）。 */}
      <div className="flex items-center gap-3">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={name}
            loading="lazy"
            decoding="async"
            className="h-10 w-10 shrink-0 rounded-md bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-md bg-neutral-200" />
        )}

        <div className="min-w-0 flex-1">
          {/* Title row：单纯产品名 */}
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[15px] font-bold leading-tight text-neutral-900">
              {name}
            </span>
          </div>

          {/* Meta（第二行）：日期 / #排名 / 分类标签（彩色 chip） */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-neutral-500">
            {dateMd && <span className="shrink-0 whitespace-nowrap tabular-nums">{dateMd}</span>}
            {dateMd && displayRank !== undefined && <span className="shrink-0 text-neutral-400">·</span>}
            {displayRank !== undefined && (
              <span className="shrink-0 whitespace-nowrap tabular-nums" title={phRawRank !== undefined && phRawRank !== displayRank ? `aifeeds 排名 #${displayRank}（PH 原始 dailyRank: ${phRawRank}）` : `PH 当日榜第 ${displayRank} 名`}>
                #{displayRank}
              </span>
            )}
            {(dateMd || displayRank !== undefined) && aiCategoryLabel && (
              <span className="shrink-0 text-neutral-400">·</span>
            )}
            {aiCategoryLabel && (
              <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${categoryStyle(aiCategoryRaw)}`}>
                {aiCategoryLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tagline 正文 — 跨整张卡宽，4 行 */}
      {tagline && (
        <p className="mt-2 line-clamp-4 text-[15px] leading-[1.45] text-neutral-900 break-words">
          {smartTruncate(tagline, 280)}
        </p>
      )}

      {/* Cover image — screenshot / video poster。100% PH items 都有 media
          screenshot 但流内之前只展示 logo (40×40)，hero shot 完全没看到。
          这里跟分享海报 cover 用同一张图源 (worker share/handlers.ts:492-515)。
          视频用同样静态 poster，点 cover 打开抽屉看完整 gallery + 视频播放。 */}
      {cover && !coverFailed && !coverRejected && (
        <div className="relative mt-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100">
          <img
            src={proxyImg(resolveAssetUrl(cover.url) || cover.url, 400)}
            alt=""
            loading="lazy"
            className="aspect-[16/9] w-full object-cover"
            onError={() => setCoverFailed(true)}
            onLoad={(e) => {
              const w = e.currentTarget.naturalWidth;
              const h = e.currentTarget.naturalHeight;
              if (!w || !h) return;
              const ar = w / h;
              const maxDim = Math.max(w, h);
              if (ar > 2 || ar < 0.5 || maxDim < 240) setCoverRejected(true);
            }}
          />
          {cover.isVideo && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white">
                <svg className="ml-0.5 h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </span>
            </span>
          )}
        </div>
      )}

      {/* Footer：左 votes/comments，右 makers 头像 + by @xxx 等 N 人。
          跨整张卡宽给 makers 行更多空间。makers span 用 flex-1 + justify-end +
          min-w-0 + 内层 truncate 兜底（仍长就省略号，不会溢出）。 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-neutral-500">
        {votes !== undefined && (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" aria-label="votes">
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l5 6H3l5-6z"/></svg>
            <span className="tabular-nums whitespace-nowrap">{formatCompact(votes)}</span>
          </span>
        )}
        {comments !== undefined && (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" aria-label="comments">
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H3a1 1 0 01-1-1V5a1 1 0 011-1z"/></svg>
            <span className="tabular-nums whitespace-nowrap">{formatCompact(comments)}</span>
          </span>
        )}
        {(visibleMakers.length > 0 || firstHandle) && (
          <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-neutral-500">
            {visibleMakers.length > 0 && (
              <span className="flex shrink-0 -space-x-1.5">
                {visibleMakers.map((m, i) => {
                  const src = resolveAssetUrl(m.avatar_url);
                  return src ? (
                    <img
                      key={m.handle || i}
                      src={src}
                      alt={m.name || m.handle || ""}
                      loading="lazy"
                      decoding="async"
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
              <span className="min-w-0 truncate whitespace-nowrap text-[13px]">
                by @{firstHandle}{makers.length > 1 ? ` 等 ${makers.length} 人` : ""}
              </span>
            )}
          </span>
        )}
      </div>
    </article>
  );
}

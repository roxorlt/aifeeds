// Podcast (AI 播客单集) feed card.
//
// 设计：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §10.2
// 视觉家族：TweetCard 家族 —— 左 72×72 方形圆角封面（非圆头像）+ 居中 play 三角
// 叠加，右内容列。token 对齐 docs/frontend-ux-guidelines.md：
//   - 卡片 px-4 py-3 hover:bg-neutral-50/60 border-b 无 shadow 无 rounded
//   - byline：节目名 · 时间 ·（A 档）[有文字稿] chip
//   - 单集标题 text-[15px] font-bold（2 行 clamp）/ 紧凑摘要 text-[13px]（2 行）
//   - 无互动数行（RSS 无播放量），用「单集时长」当 meta 替代
//   - play 三角复用 PhCard 的 <path d="M8 5v14l11-7z"/>，严禁 ▶ emoji
//
// 注：blog/podcast 无 metrics，不挂 useImpressionRefresh（无 refresh-metrics cron）。

import { useState } from "react";
import type { Item, ItemExtra } from "../types";
import { buildResponsiveCardImage, cn, parseJsonField, timeAgo, variantsForCurrentCover } from "../lib/utils";
import { useDrawer } from "../lib/drawerContext";
import {
  LAZY_MEDIA_LOAD_POLICY,
  getMediaPriorityTelemetryLabel,
  type MediaLoadPolicy,
} from "../lib/mediaPriority";
import { IconAudioLines, IconClock, IconMic, IconUser } from "./icons";
import { HL } from "./search/highlight";

interface Props {
  item: Item;
  mediaPolicy?: MediaLoadPolicy;
  // 海报模式(PosterCanvas 截图):突出「这是音频」+ 主持/嘉宾,增信息量(2026-06-12 #2)。
  posterMode?: boolean;
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

// 海报里节目简介用 list DTO 的紧凑 excerpt，轻量去除可能残留的 markdown 标记。
function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")     // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // 链接 → 文字
    .replace(/^#{1,6}\s+/gm, "")               // 标题井号
    .replace(/[*_`>]/g, "")                    // 强调/引用标记
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function PodcastCard({
  item,
  mediaPolicy = LAZY_MEDIA_LOAD_POLICY,
  posterMode,
}: Props) {
  const drawer = useDrawer();
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverVariantFailed, setCoverVariantFailed] = useState(false);

  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);

  const showName = extra.show_name || extra.source_company || item.author || "";
  // 海报态:主持/嘉宾(podcast:person 结构化 + LLM 抽取)分行带图标展示。
  // guests 对 hosts 去重(显示层兜底:LLM 偶尔把固定主持当嘉宾抽,如 Practical AI)。
  const hostsArr = Array.isArray(extra.hosts)
    ? (extra.hosts as unknown[]).filter((h): h is string => typeof h === "string" && !!h.trim())
    : [];
  const hostLower = new Set(hostsArr.map((h) => h.toLowerCase()));
  const guestsArr = Array.isArray(extra.guests)
    ? (extra.guests as unknown[]).filter(
        (g): g is string => typeof g === "string" && !!g.trim() && !hostLower.has(g.toLowerCase()),
      )
    : [];
  // 本期话题脉络(奥卡姆剃刀时间轴)—— 海报里露前几条增信息量(2026-06-12 #5)。
  // 单节点不成"轴"(烂源 VTT 偶发产物),≥2 才渲染。
  const timelineRaw = Array.isArray(extra.timeline) ? extra.timeline : [];
  const timeline = timelineRaw.length >= 2 ? timelineRaw : [];
  // 单集标题优先中译；摘要只消费 list DTO 的紧凑字段。
  const title = extra.title_zh || item.title || "";
  const summary =
    extra.ai_summary_zh ||
    extra.excerpt_zh ||
    extra.excerpt ||
    item.content_translated ||
    item.content ||
    "";
  // 海报「节目简介」同样使用紧凑字段，缺失时回退 ai_summary。
  const isForeign = (item.lang || "") !== "zh";
  const excerpt = isForeign
    ? extra.excerpt_zh || extra.excerpt || ""
    : extra.excerpt || extra.excerpt_zh || "";
  const posterDesc = plainText(excerpt || extra.ai_summary_zh || extra.ai_summary || "");

  const time = timeAgo(item.published_at);
  const duration = formatDuration(extra.duration_sec);

  const coverImage = extra.cover_image || "";
  const coverVariants = variantsForCurrentCover(
    coverImage,
    extra.cover_variant_source,
    extra.cover_image_variants,
  );

  function open() {
    drawer.openItem(item);
  }

  // 封面 + play 叠加（海报/流内共用，size 控制尺寸）。
  const coverEl = (size: "feed" | "poster") => (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-xl bg-neutral-100",
        size === "poster" ? "h-28 w-28" : "h-[72px] w-[72px]",
      )}
      data-feed-source={item.source_type}
      data-media-priority={getMediaPriorityTelemetryLabel(mediaPolicy)}
    >
      {coverImage && !coverFailed ? (() => {
        const source = buildResponsiveCardImage(coverImage, coverVariants, {
          fallbackWidth: size === "poster" ? 320 : 200,
          widths: size === "poster" ? [320, 400] : [200, 400],
        });
        const renderedSize = size === "poster" ? 112 : 72;
        return (
          <picture className="block h-full w-full">
            {source.webpSrcSet && !coverVariantFailed && (
              <source type="image/webp" srcSet={source.webpSrcSet} sizes={`${renderedSize}px`} />
            )}
            <img
              src={source.fallbackSrc}
              srcSet={source.srcSet}
              sizes={`${renderedSize}px`}
              width={renderedSize}
              height={renderedSize}
              alt=""
              loading={mediaPolicy.loading}
              fetchPriority={mediaPolicy.fetchPriority}
              decoding="async"
              className="h-full w-full object-cover"
              onError={() => {
                if (source.webpSrcSet && !coverVariantFailed) {
                  setCoverVariantFailed(true);
                } else {
                  setCoverFailed(true);
                }
              }}
            />
          </picture>
        );
      })() : (
        <div
          className="flex h-full w-full items-center justify-center text-[22px] font-bold text-white"
          style={{ background: monoColor(showName || "podcast") }}
          aria-hidden="true"
        >
          {monoLetter(showName)}
        </div>
      )}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className={cn(
            "flex items-center justify-center rounded-full bg-black/55 text-white",
            size === "poster" ? "h-11 w-11" : "h-8 w-8",
          )}
        >
          <PlayTriangle className={cn("ml-0.5", size === "poster" ? "h-5 w-5" : "h-4 w-4")} />
        </span>
      </span>
    </div>
  );

  // ── 海报态:专用版式 ──────────────────────────────────────────────────────
  // 上部 header(封面左 + 标题/主持/嘉宾/时长右)→ 节目简介(全宽)→ 话题脉络(全宽,
  // 全节点,海报高度自适应)。所有含换行文字的行一律用 inline/block 流(不用 flex)——
  // modern-screenshot 截图时 flex 行内的换行文字会高度算错、压到下一兄弟元素
  // (2026-06-18 实测重叠 bug 根因)。
  if (posterMode) {
    return (
      <article className="px-5 py-4">
        {/* Header */}
        <div className="flex gap-4">
          {coverEl("poster")}
          <div className="min-w-0 flex-1">
            {showName && (
              <div className="text-[13px] font-medium leading-snug text-neutral-500">
                {showName}
                {time ? ` · ${time}` : ""}
              </div>
            )}
            <h3 className="mt-1 text-[16px] font-bold leading-snug text-neutral-900">{title}</h3>
            {hostsArr.length > 0 && (
              <div className="mt-1.5 text-[13px] leading-relaxed">
                <IconMic className="mr-1 inline-block h-3.5 w-3.5 -translate-y-px align-middle text-neutral-400" />
                <span className="font-medium text-neutral-500">主持 </span>
                <span className="font-medium text-neutral-700">{hostsArr.slice(0, 3).join("、")}</span>
              </div>
            )}
            {guestsArr.length > 0 && (
              <div className="mt-0.5 text-[13px] leading-relaxed">
                <IconUser className="mr-1 inline-block h-3.5 w-3.5 -translate-y-px align-middle text-neutral-400" />
                <span className="font-medium text-neutral-500">嘉宾 </span>
                <span className="font-medium text-neutral-700">{guestsArr.slice(0, 3).join("、")}</span>
              </div>
            )}
            <div className="mt-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-neutral-900 px-2.5 py-1 text-[12px] font-semibold text-white">
              <IconAudioLines className="h-3.5 w-3.5 shrink-0" />
              收听播客{duration ? ` · ${duration}` : ""}
            </div>
          </div>
        </div>

        {/* 节目简介(全宽,左对齐到封面左边) */}
        {posterDesc && (
          <div className="mt-4">
            <div className="mb-1.5 text-[12px] font-semibold text-neutral-500">节目简介</div>
            <p className="text-[13px] leading-[1.6] text-neutral-600 line-clamp-5">{posterDesc}</p>
          </div>
        )}

        {/* 本期话题脉络(全宽,全部节点,海报高度自适应) */}
        {timeline.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[12px] font-semibold text-neutral-500">本期话题脉络</div>
            <div className="space-y-2.5">
              {timeline.map((seg, i) => (
                <div key={i} className="leading-snug">
                  <div>
                    <span className="mr-2 text-[12px] font-semibold tabular-nums text-neutral-400">{seg.ts}</span>
                    <span className="text-[14px] font-semibold text-neutral-900">{seg.topic}</span>
                  </div>
                  {seg.point && (
                    <div className="mt-0.5 text-[13px] leading-[1.55] text-neutral-600">{seg.point}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </article>
    );
  }

  // ── 流内卡片态(TweetCard 家族:左封面 + 右内容列)──────────────────────────
  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex gap-3">
        {coverEl("feed")}

        {/* 右：byline / 标题 / 摘要 / 时长 */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500">
            {showName && <span className="truncate font-medium text-neutral-700">{showName}</span>}
            {time && (
              <>
                <span className="shrink-0 text-neutral-400">·</span>
                <span className="shrink-0 whitespace-nowrap">{time}</span>
              </>
            )}
          </div>

          <h3 className="mt-0.5 line-clamp-2 text-[15px] font-bold leading-tight text-neutral-900 break-words">
            <HL text={title} />
          </h3>

          {summary && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-[1.5] text-neutral-600 break-words"><HL text={summary} /></p>
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

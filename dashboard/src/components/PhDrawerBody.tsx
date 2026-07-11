// Product Hunt drawer body — 9 sections per mockup
// docs/plans/_mockups/2026-05-03-ph-drawer-mockup.html
//
// 视觉对齐 docs/frontend-ux-guidelines.md：
//   - 全 neutral 调色（chip 用 bg-neutral-100，不再 14 色家族）
//   - 标题 text-[15px] font-bold / 正文 text-[15px] / meta text-[13px] text-neutral-500
//   - 边框 border-neutral-200，section 间用 border-b，无 shadow
//   - 链接 text-sky-600 hover:underline
//   - icon 改成 SVG（neutral 描线 / 填充），不用 emoji
//
// 9 段：
//   1. 产品头部 (logo + name + tagline + rank + cat chip + 官网弱链接)
//   2. KPI 行 (votes / comments / reviews / followers)
//   3. Gallery 横滑 + Lightbox
//   4. AI 解读 (无标题，bg-neutral-50/40)
//   5. Maker post (MAKER chip + 翻译 toggle)
//   6. 团队 + Hunter
//   7. Top Reviews (5)
//   8. Top 评论 (10，maker reply 嵌套)
//   9. 更多 (论坛 / 类似产品出链 + Pricing chips)

import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { Item, ItemExtra, MediaItem, PhComment, PhMetrics, PhReview } from "../types";
import { cn, formatCompact, ordinal, parseJsonField } from "../lib/utils";
import { Lightbox } from "./Lightbox";
import { resolveAssetUrl } from "../lib/asset";
import { useCoordinatedVideo } from "../lib/useCoordinatedVideo";
import { useDrawer } from "../lib/drawerContext";
import { fetchItems } from "../api";

// 抽屉 gallery 内单个直链 mp4 视频 — hook 接 VideoCoordinator
// columnId 由父级 <VideoColumnProvider value="drawer"> 自动 inject，组件本身不写
function PhGalleryVideo({
  src,
  itemId,
  slot,
}: {
  src: string;
  itemId: string;
  slot: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const { muted } = useCoordinatedVideo({
    videoId: `product_hunt:${itemId}:gallery:${slot}`,
    videoRef: ref,
  });
  return (
    <video
      ref={ref}
      src={src}
      className="h-44 w-72 shrink-0 snap-start rounded-md bg-neutral-200 object-cover"
      controls
      muted={muted}
      preload="none"
      playsInline
      loop
    />
  );
}

// 外链强制 target="_blank" + rel="noopener noreferrer" — DOMPurify hook 一次注册
// 终生生效；放在模块顶层（非组件内）避免重复 add hook。
if (typeof window !== "undefined") {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

const PH_COMMENT_SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["p", "br", "a", "strong", "em", "b", "i", "u", "code", "pre", "blockquote", "ul", "ol", "li", "img", "span"],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class"],
};

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

function aiCategoryLabel(slug: string): string {
  if (!slug) return "";
  return slug
    .replace(/^ai_/, "AI ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/^Ai /, "AI ");
}

// PH 分类彩色 chip（跟 PhCard 保持一致）
const PH_CATEGORY_STYLE: Record<string, string> = {
  ai_agent: "bg-violet-100 text-violet-700",
  ai_code_editor: "bg-blue-100 text-blue-700",
  ai_image_gen: "bg-rose-100 text-rose-700",
  ai_audio: "bg-amber-100 text-amber-700",
  ai_voice_agent: "bg-orange-100 text-orange-700",
  ai_data_analysis: "bg-emerald-100 text-emerald-700",
  ai_other: "bg-neutral-100 text-neutral-700",
};

function phCategoryStyle(cat: string | undefined): string {
  if (!cat) return "bg-neutral-100 text-neutral-700";
  return PH_CATEGORY_STYLE[cat] || "bg-neutral-100 text-neutral-700";
}

const PRICING_LABEL: Record<string, string> = {
  free: "Free",
  free_options: "Freemium",
  paid: "Paid",
  subscription: "订阅",
  free_trial: "Free Trial",
};

function tryHostFromUrl(url: string | undefined | null): string {
  if (!url) return "";
  try { return new URL(url).host; } catch { return ""; }
}

interface Props {
  item: Item;
}

type TabState = "translated" | "original";

// ─── Inline icons (neutral, flat — match TweetCard / GH style) ──────────────
const IconUpvote = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" className={className}><path d="M8 2l5 6H3l5-6z"/></svg>
);
const IconComment = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}><path d="M3 4h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H3a1 1 0 01-1-1V5a1 1 0 011-1z"/></svg>
);
const IconStar = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" className={className}><path d="M8 1l2.2 4.6 5 .7-3.6 3.5.9 5L8 12.3 3.5 14.8l.9-5L.8 6.3l5-.7L8 1z"/></svg>
);
const IconFollow = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}><circle cx="8" cy="6" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
);

export function PhDrawerBody({ item }: Props) {
  const drawer = useDrawer();
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<PhMetrics>(item.metrics) ?? ({} as PhMetrics);
  const media = parseMedia(item.media);

  // 同类产品（站内）：拉一页 PH feed，按共享的具体 topic 匹配“同类型”。
  // pool module 级缓存，computeRelatedPh 见文件底部。item 切换（点进同类产品）
  // 时按 item.id 重算。
  const [related, setRelated] = useState<Item[]>([]);
  useEffect(() => {
    let cancelled = false;
    setRelated([]);
    loadPhPool().then((pool) => {
      if (!cancelled) setRelated(computeRelatedPh(item, pool));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const name = item.title || "?";
  const tagline = item.content || "";
  const taglineTranslated = item.content_translated || "";
  // display_rank: 后端 ROW_NUMBER 给同日内连续编号 1,2,3...N（绕过 PH displayRank 跳号/重复）。
  // daily_rank: PH 原始值，留 tooltip 调试。
  const ex = extra as { daily_rank?: number; display_rank?: number };
  const displayRank = ex.display_rank ?? ex.daily_rank;
  const phRawRank = ex.daily_rank;
  const launchDate = extra.launch_date_pt || "";
  const phUrl = extra.ph_url || item.url || "";
  const websiteUrl = (extra.website_url as string) || "";
  const aiCategory = (extra.ai_category as string) || "";
  const aiCategoryText = aiCategoryLabel(aiCategory);
  const aiSummary = (extra.ai_summary as string) || "";

  const logo = media.find((m) => (m as MediaItem & { role?: string }).role === "logo");
  const logoUrl = logo?.url ? resolveAssetUrl(logo.url) : "";
  const galleryItems = media.filter((m) => (m as MediaItem & { role?: string }).role !== "logo");

  const makers = (extra.makers as Array<{ name?: string; handle?: string; avatar_url?: string; profile_url?: string }>) || [];
  const hunter = (extra.hunter as { name?: string; handle?: string; avatar_url?: string }) || null;
  const makerHandles = new Set(makers.map((m) => m.handle).filter(Boolean) as string[]);

  const makerPost = (extra.maker_post as PhComment) || null;
  const makerPostText = (extra.maker_post_text as string) || makerPost?.text || "";
  const makerPostTranslated = (extra.maker_post_translated as string) || "";

  const allTopComments = (extra.top_comments as PhComment[]) || [];
  // 过滤掉 phantom rows（无 text 或无 handle 的，旧数据 dom_extract 误抓
  // comment-form / comment-menu-button 等非评论 DOM 时会留空 row）。
  //
  // dedup-by-handle：scraper 当前抓的是所有 [data-test^="comment-"] DOM
  // 节点，把回复也算进了顶级评论，导致同一作者多次出现（schole-2 vinitra
  // × 5、manus 早期数据 orion_zou × 3）。彻底修复需要 scraper 按 thread
  // 容器抓 top-level only，先在渲染层每作者只留最高赞那条压住表象。
  const topComments = (() => {
    const byHandle = new Map<string, PhComment>();
    const noHandleOut: PhComment[] = [];
    for (const c of allTopComments) {
      const text = (c.text || "").trim();
      const handle = (c.author_handle || "").trim();
      if (!text && !handle) continue;
      if (!handle) {
        noHandleOut.push(c);
        continue;
      }
      const prev = byHandle.get(handle);
      if (!prev) {
        byHandle.set(handle, c);
        continue;
      }
      // 同 handle 已有 → 留 upvotes 高的那条
      const prevVotes = prev.upvotes ?? -1;
      const curVotes = c.upvotes ?? -1;
      if (curVotes > prevVotes) byHandle.set(handle, c);
    }
    return [...byHandle.values(), ...noHandleOut];
  })();
  const topReviews = (extra.top_reviews as PhReview[]) || [];

  const pricingType = (extra.pricing_type as string) || metrics.pricing_type || "";
  const pricingLabel = PRICING_LABEL[pricingType];
  const isOpenSource = !!extra.is_open_source;

  // Tab state for translation toggle
  const [makerTab, setMakerTab] = useState<TabState>("translated");
  const [commentTab, setCommentTab] = useState<TabState>("translated");
  const [reviewTab, setReviewTab] = useState<TabState>("translated");

  // Lightbox
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxMedia = galleryItems.map((m) => ({
    type: m.type === "video" ? "video" : "image",
    url: resolveAssetUrl(m.url),
  } as MediaItem));

  return (
    <div className="text-neutral-900">
      {/* ① 产品头部 */}
      <div className="border-b border-neutral-200 p-5" data-drawer-title-anchor>
        <div className="flex items-start gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={name}
              className="h-12 w-12 shrink-0 rounded-md bg-neutral-200 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <div className="h-12 w-12 shrink-0 rounded-md bg-neutral-200" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[17px] font-bold leading-tight text-neutral-900 break-words">
                {name}
              </span>
            </div>
            {/* tagline 用译文（若有），原文小字辅助 */}
            <div className="mt-0.5 text-[14px] text-neutral-700">
              {taglineTranslated || tagline}
            </div>
            {/* meta line：日期(无 PT) / #排名 / 分类标签（彩色 chip）
                votes 回到下方 KPI 行（不再挪上来） */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-neutral-500">
              {launchDate && <span className="tabular-nums">{launchDate}</span>}
              {launchDate && displayRank !== undefined && <span className="text-neutral-400">·</span>}
              {displayRank !== undefined && (
                <span className="tabular-nums" title={phRawRank !== undefined && phRawRank !== displayRank ? `aifeeds 排名 #${displayRank}（PH 原始 dailyRank: ${phRawRank}）` : `PH 当日榜第 ${displayRank} 名`}>
                  #{displayRank}
                </span>
              )}
              {(launchDate || displayRank !== undefined) && aiCategoryText && <span className="text-neutral-400">·</span>}
              {aiCategoryText && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${phCategoryStyle(aiCategory)}`}>
                  {aiCategoryText}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 官网弱链接 */}
        {websiteUrl && (
          <div className="mt-3 text-[13px] text-neutral-500">
            官网：
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {tryHostFromUrl(websiteUrl) || websiteUrl}
            </a>
            <span className="ml-0.5 text-neutral-400">↗</span>
          </div>
        )}
      </div>

      {/* ② KPI 行 — 4 列各 1/4，跟海报对齐（votes / comments / reviews /
          followers）。短期热度（votes/comments）+ 长期口碑（reviews/followers）
          全维度展示。缺数据列 / value === 0 都显 "—"（兜底 scraper 多 launch
          老产品 votesCount 抓 0 的视觉污染，等 backfill 后真值显示）。 */}
      {(metrics.votes !== undefined || metrics.comments !== undefined || metrics.reviews_count !== undefined || metrics.followers !== undefined) && (
        <div className="grid grid-cols-4 gap-2 border-b border-neutral-200 px-5 py-4 text-center">
          <Kpi
            icon={<IconUpvote className="h-3.5 w-3.5" />}
            label="votes"
            value={metrics.votes && metrics.votes > 0 ? formatCompact(metrics.votes) : "—"}
          />
          <Kpi
            icon={<IconComment className="h-3.5 w-3.5" />}
            label="comments"
            value={metrics.comments && metrics.comments > 0 ? formatCompact(metrics.comments) : "—"}
          />
          <Kpi
            icon={<IconStar className="h-3.5 w-3.5" />}
            label={metrics.reviews_count ? `${metrics.reviews_count} reviews` : "reviews"}
            value={
              metrics.reviews_count && metrics.reviews_avg !== undefined
                ? metrics.reviews_avg.toFixed(2)
                : "—"
            }
          />
          <Kpi
            icon={<IconFollow className="h-3.5 w-3.5" />}
            label="followers"
            value={metrics.followers && metrics.followers > 0 ? formatCompact(metrics.followers) : "—"}
          />
        </div>
      )}

      {/* ③ Gallery 横滑 */}
      {galleryItems.length > 0 && (
        <div className="border-b border-neutral-200 py-4">
          <div className="mb-2 px-5 text-[13px] font-medium text-neutral-500">截图与视频</div>
          {/* 横滑首图必须留 20px padding。坑：snap-mandatory + snap-start
              会强制把首图左边缘吸附到 scrollport 左边缘，把 px-5 padding
              滚出视野。修法：在外层 scroll 容器加 scroll-px-5（snap 视
              padding 为 scrollport 边界，snap 点偏移 20px），同时内层
              flex 仍用 px-5 保证非 snap 状态下也有间距。 */}
          <div className="overflow-x-auto scroll-px-5 no-scrollbar">
            <div className="flex snap-x snap-mandatory gap-2 px-5">
              {galleryItems.map((m, i) => {
                const url = resolveAssetUrl(m.url);
                // PH 视频：embed (YouTube/Vimeo, platform 非空) 用 <iframe>，
                // 直链 mp4 (platform="") 用 <video>。无 platform 字段（旧
                // 数据 / X 兼容）默认走 <video>。
                const mWithPlatform = m as MediaItem & { platform?: string; video_id?: string };
                const isEmbed = m.type === "video" && !!mWithPlatform.platform;
                if (isEmbed) {
                  const vid = mWithPlatform.video_id || "";
                  const embedUrl =
                    mWithPlatform.platform === "youtube"
                      ? `https://www.youtube-nocookie.com/embed/${vid}`
                      : mWithPlatform.platform === "vimeo"
                        ? `https://player.vimeo.com/video/${vid}`
                        : url;
                  return (
                    <iframe
                      key={i}
                      src={embedUrl}
                      className="h-44 w-72 shrink-0 snap-start rounded-md border-0 bg-black"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      title={`Video ${i + 1}`}
                    />
                  );
                }
                return m.type === "video" ? (
                  <PhGalleryVideo key={i} src={url} itemId={item.id} slot={i} />
                ) : (
                  <img
                    key={i}
                    src={url}
                    className="h-44 w-72 shrink-0 cursor-zoom-in snap-start rounded-md bg-neutral-200 object-cover"
                    loading="lazy"
                    alt=""
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxIndex(i);
                    }}
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ④ AI 解读 — 无标题，bg-neutral-50/40 弱化 */}
      {aiSummary && (
        <div className="border-b border-neutral-200 bg-neutral-50/40 p-5">
          <p className="text-[15px] leading-[1.55] text-neutral-800">{aiSummary}</p>
        </div>
      )}

      {/* ⑤ Maker post */}
      {makerPostText && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-2.5 flex items-center gap-2">
            {makerPost?.avatar_url ? (
              <img
                src={resolveAssetUrl(makerPost.avatar_url)}
                alt={makerPost.author_name || ""}
                className="h-8 w-8 rounded-full bg-neutral-200 object-cover"
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              />
            ) : (
              <div className="h-8 w-8 rounded-full bg-neutral-200" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="text-[15px] font-bold text-neutral-900">
                  {makerPost?.author_name || makers[0]?.name}
                </span>
                {makerPost?.author_handle && (
                  <span className="text-[13px] text-neutral-500">@{makerPost.author_handle}</span>
                )}
                <span className="rounded-full bg-neutral-100 px-1.5 py-0 text-[11px] font-medium text-neutral-700">
                  Maker
                </span>
              </div>
            </div>
            {makerPostTranslated && (
              <TranslateToggle tab={makerTab} onChange={setMakerTab} />
            )}
          </div>
          <p className="whitespace-pre-wrap text-[15px] leading-[1.55] text-neutral-800">
            {makerTab === "translated" && makerPostTranslated ? makerPostTranslated : makerPostText}
          </p>
        </div>
      )}

      {/* ⑥ 团队 + Hunter */}
      {(makers.length > 0 || hunter) && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-2.5 text-[13px] font-medium text-neutral-500">团队 & Hunter</div>
          <div className="flex flex-wrap gap-3">
            {makers.map((m, i) => (
              <PersonBadge key={`m${i}`} person={m} role="Maker" />
            ))}
            {hunter && <PersonBadge person={hunter} role="Hunter" />}
          </div>
        </div>
      )}

      {/* ⑦ Top Reviews */}
      {topReviews.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-[13px] font-medium text-neutral-500">
              {metrics.reviews_avg !== undefined && (
                <span className="text-neutral-700">⭐ {metrics.reviews_avg.toFixed(2)} </span>
              )}
              · {metrics.reviews_count ?? topReviews.length} reviews
            </div>
            <TranslateToggle tab={reviewTab} onChange={setReviewTab} />
          </div>
          <div className="space-y-3">
            {topReviews.map((r, i) => (
              <ReviewItem key={i} review={r} tab={reviewTab} />
            ))}
            {phUrl && (
              <div className="pt-1 text-center">
                <a
                  href={`${phUrl}/reviews`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] text-sky-600 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  在 PH 看全部
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⑧ Top 评论 */}
      {topComments.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="text-[13px] font-medium text-neutral-500">
              Top 评论 · 共 {metrics.comments ?? topComments.length}
            </div>
            <TranslateToggle tab={commentTab} onChange={setCommentTab} />
          </div>
          <div className="space-y-4">
            {topComments.map((c, i) => (
              <CommentItem key={i} comment={c} tab={commentTab} makerHandles={makerHandles} />
            ))}
            {phUrl && (
              <div className="pt-2 text-center">
                <a
                  href={phUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] text-sky-600 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  查看全部 {metrics.comments ?? "..."} 条评论
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⑨ 同类产品（站内）+ Pricing */}
      {(related.length > 0 || pricingLabel || isOpenSource) && (
        <div className="border-b border-neutral-200 p-5">
          {related.length > 0 && (
            <>
              <div className="mb-2 text-[13px] font-medium text-neutral-500">同类产品</div>
              <div className="space-y-0.5">
                {related.map((r) => (
                  <RelatedPhRow key={r.id} item={r} onOpen={() => drawer.pushItem(r)} />
                ))}
              </div>
            </>
          )}

          {/* Pricing chips — neutral 风格 */}
          {(pricingLabel || isOpenSource) && (
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500",
                related.length > 0 && "mt-3",
              )}
            >
              {pricingLabel && (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                  {pricingLabel}
                </span>
              )}
              {isOpenSource && (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                  开源
                </span>
              )}
              {displayRank !== undefined && (
                <span className="ml-auto text-[11px] text-neutral-400">{ordinal(displayRank)} on PH</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && lightboxMedia.length > 0 && (
        <Lightbox
          media={lightboxMedia}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

// ───────────── Sub-components ─────────────

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[15px] font-bold text-neutral-900 tabular-nums">
        <span className="text-neutral-500">{icon}</span>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-neutral-500">{label}</div>
    </div>
  );
}

function TranslateToggle({ tab, onChange }: { tab: TabState; onChange: (t: TabState) => void }) {
  return (
    <div className="flex gap-0 rounded-md border border-neutral-200 p-0.5">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onChange("translated"); }}
        className={cn(
          "rounded px-2 py-0.5 text-[11px]",
          tab === "translated" ? "bg-neutral-100 font-semibold text-neutral-900" : "text-neutral-500 hover:text-neutral-700",
        )}
      >
        译文
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onChange("original"); }}
        className={cn(
          "rounded px-2 py-0.5 text-[11px]",
          tab === "original" ? "bg-neutral-100 font-semibold text-neutral-900" : "text-neutral-500 hover:text-neutral-700",
        )}
      >
        原文
      </button>
    </div>
  );
}

function PersonBadge({ person, role }: {
  person: { name?: string; handle?: string; avatar_url?: string; profile_url?: string };
  role: string;
}) {
  const avatar = person.avatar_url ? resolveAssetUrl(person.avatar_url) : "";
  return (
    <div className="flex items-center gap-2">
      {avatar ? (
        <img
          src={avatar}
          alt={person.name || ""}
          className="h-8 w-8 rounded-full bg-neutral-200 object-cover"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      ) : (
        <div className="h-8 w-8 rounded-full bg-neutral-200" />
      )}
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-neutral-900 truncate">{person.name}</div>
        <div className="text-[11px] text-neutral-500 truncate">
          {person.handle && `@${person.handle}`}
          {person.handle && " · "}
          {role}
        </div>
      </div>
    </div>
  );
}

function ReviewItem({ review, tab }: { review: PhReview; tab: TabState }) {
  const body = tab === "translated" && review.body_translated ? review.body_translated : review.body || "";
  const stars = review.rating ? "⭐".repeat(Math.round(review.rating)) : "";
  const avatar = review.avatar_url ? resolveAssetUrl(review.avatar_url) : "";
  return (
    <div className="rounded-md border border-neutral-200 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        {avatar ? (
          <img src={avatar} alt="" className="h-6 w-6 rounded-full bg-neutral-200 object-cover" />
        ) : (
          <div className="h-6 w-6 rounded-full bg-neutral-200" />
        )}
        <span className="text-[13px] font-medium text-neutral-900">{review.author_name}</span>
        {stars && <span className="text-[11px] text-amber-500">{stars}</span>}
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-[1.55] text-neutral-700">{body}</p>
    </div>
  );
}

function CommentItem({
  comment,
  tab,
  makerHandles,
}: {
  comment: PhComment;
  tab: TabState;
  makerHandles: Set<string>;
}) {
  // 渲染选择：
  //   - 翻译态（中文）→ 翻译来自 DeepSeek 是纯文本，用 whitespace-pre-wrap
  //   - 原文态：优先 body_html（新 row，DOMPurify 渲染保留链接 / 图片 / 段落）
  //                  fallback text 字段（旧 row 是已 stripped 的纯文本，pre-wrap 维持当前观感）
  const showTranslated = tab === "translated" && !!comment.translated;
  const useHtml = !showTranslated && !!comment.body_html;
  const sanitized = useHtml
    ? DOMPurify.sanitize(comment.body_html as string, PH_COMMENT_SANITIZE_CONFIG)
    : "";
  const plainBody = showTranslated ? (comment.translated as string) : (comment.text || "");
  const isMaker = !!comment.author_handle && makerHandles.has(comment.author_handle);
  const avatar = comment.avatar_url ? resolveAssetUrl(comment.avatar_url) : "";
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        {avatar ? (
          <img src={avatar} alt="" className="h-7 w-7 rounded-full bg-neutral-200 object-cover" />
        ) : (
          <div className="h-7 w-7 rounded-full bg-neutral-200" />
        )}
        <span className="text-[13px] font-medium text-neutral-900">{comment.author_name}</span>
        {comment.author_handle && (
          <span className="text-[11px] text-neutral-500">@{comment.author_handle}</span>
        )}
        {isMaker && (
          <span className="rounded-full bg-neutral-100 px-1.5 py-0 text-[11px] font-medium text-neutral-700">
            Maker
          </span>
        )}
      </div>
      {useHtml ? (
        <div
          className="ml-9 ph-comment-html text-[15px] leading-[1.55] text-neutral-800"
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      ) : (
        <p className="ml-9 whitespace-pre-wrap text-[15px] leading-[1.55] text-neutral-800">{plainBody}</p>
      )}
      {comment.upvotes !== undefined && comment.upvotes !== null && (
        <div className="ml-9 mt-1 inline-flex items-center gap-1 text-[12px] text-neutral-500">
          <IconUpvote className="h-3 w-3" />
          {comment.upvotes}
        </div>
      )}
    </div>
  );
}

// ─── 同类产品（站内）─────────────────────────────────────────────────
// FE-only：拉一页 PH feed 做“同类型”匹配 — 共享 PH 原生 topic 标签即算同类。
// 'artificial-intelligence' 几乎每条都带（≈80%），无区分度，作为通用标签剔除；
// 真正决定“同类型”的是更具体的 topic（design-tools / marketing / mac …）。
// ai_category 命中作次要加权（ai_other 是 catch-all，不计）。
// pool 在 module 级缓存（每次页面加载只拉一次），避免每开一个 PH 抽屉都重拉。
const GENERIC_PH_TOPICS = new Set(["artificial-intelligence"]);
const RELATED_POOL_LIMIT = 150;
const RELATED_MAX = 6;

let phPoolPromise: Promise<Item[]> | null = null;
function loadPhPool(): Promise<Item[]> {
  if (!phPoolPromise) {
    phPoolPromise = fetchItems({ source_type: "product_hunt", limit: RELATED_POOL_LIMIT })
      .then((r) => r.items)
      .catch(() => {
        phPoolPromise = null; // 失败不缓存，下个抽屉可重试
        return [];
      });
  }
  return phPoolPromise;
}

function topicsOf(it: Item): string[] {
  const ex = parseJsonField<{ topics?: unknown }>(it.extra) ?? {};
  return Array.isArray(ex.topics) ? (ex.topics.filter((x) => typeof x === "string") as string[]) : [];
}

function computeRelatedPh(current: Item, pool: Item[]): Item[] {
  const curExtra = parseJsonField<ItemExtra>(current.extra) ?? ({} as ItemExtra);
  const curSpecific = new Set(topicsOf(current).filter((t) => !GENERIC_PH_TOPICS.has(t)));
  const curCat = (curExtra.ai_category as string) || "";
  // 没有具体 topic（只挂通用 AI 标签）→ 无可靠“同类”信号，不展示
  if (curSpecific.size === 0) return [];

  const scored: Array<{ item: Item; score: number }> = [];
  for (const cand of pool) {
    if (cand.id === current.id) continue;
    let shared = 0;
    for (const t of topicsOf(cand)) if (curSpecific.has(t)) shared++;
    if (shared === 0) continue; // 必须共享 ≥1 个具体 topic 才算“同类”（仅 ai_category 相同不算）
    // 同 ai_category 仅作 topic 命中者之间的次要排序加权（ai_other 是 catch-all 不计）
    const cCat = ((parseJsonField<ItemExtra>(cand.extra) ?? ({} as ItemExtra)).ai_category as string) || "";
    const score = shared * 10 + (curCat && curCat !== "ai_other" && cCat === curCat ? 5 : 0);
    scored.push({ item: cand, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, RELATED_MAX).map((s) => s.item);
}

const IconChevronRight = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}><path d="M6 4l4 4-4 4" /></svg>
);

function RelatedPhRow({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const media = parseMedia(item.media);
  const logo = media.find((m) => (m as MediaItem & { role?: string }).role === "logo");
  const logoUrl = logo?.url ? resolveAssetUrl(logo.url) : "";
  const name = item.title || "?";
  const tagline = (extra.ai_summary as string) || item.content_translated || item.content || "";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-neutral-50/60"
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-9 w-9 shrink-0 rounded-md bg-neutral-200 object-cover"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      ) : (
        <div className="h-9 w-9 shrink-0 rounded-md bg-neutral-200" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-neutral-900">{name}</div>
        {tagline && <div className="truncate text-[11px] text-neutral-500">{tagline}</div>}
      </div>
      <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
    </button>
  );
}

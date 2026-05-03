// Product Hunt drawer body — 9 sections per mockup
// docs/plans/_mockups/2026-05-03-ph-drawer-mockup.html
//
// Section order (top → bottom):
//   1. Product header (logo + name + tagline + rank + cat chips + 官网 link)
//   2. KPI 行 (votes / comments / reviews / followers)
//   3. Gallery (横滑 + Lightbox)
//   4. AI 解读 (无标题，bg-neutral-50/40)
//   5. Maker post（翻译切换）
//   6. 团队 (makers + hunter)
//   7. Top Reviews (5)
//   8. Top 评论 (10，含 maker reply 嵌套，翻译切换)
//   9. 更多 (论坛 / 类似产品 出链 + pricing chips)

import { useMemo, useState } from "react";
import type { Item, ItemExtra, MediaItem, PhComment, PhMetrics, PhReview } from "../types";
import { cn, formatCompact, ordinal, parseJsonField } from "../lib/utils";
import { Lightbox } from "./Lightbox";

const AI_CATEGORY_STYLE: Record<string, { label: string; cls: string }> = {
  ai_code_editor:    { label: "AI Code Editor",    cls: "bg-violet-50 text-violet-700 ring-1 ring-violet-200" },
  ai_chatbot:        { label: "AI Chatbot",        cls: "bg-sky-50 text-sky-700 ring-1 ring-sky-200" },
  ai_agent:          { label: "AI Agent",          cls: "bg-rose-50 text-rose-700 ring-1 ring-rose-200" },
  ai_image_gen:      { label: "AI Image Gen",      cls: "bg-pink-50 text-pink-700 ring-1 ring-pink-200" },
  ai_video_gen:      { label: "AI Video Gen",      cls: "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200" },
  ai_audio:          { label: "AI Audio",          cls: "bg-amber-50 text-amber-700 ring-1 ring-amber-200" },
  ai_writing:        { label: "AI Writing",        cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" },
  ai_search:         { label: "AI Search",         cls: "bg-blue-50 text-blue-700 ring-1 ring-blue-200" },
  ai_dev_tool:       { label: "AI Dev Tool",       cls: "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200" },
  ai_workflow:       { label: "AI Workflow",       cls: "bg-orange-50 text-orange-700 ring-1 ring-orange-200" },
  ai_voice_agent:    { label: "AI Voice Agent",    cls: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" },
  ai_data_analysis:  { label: "AI Data Analysis",  cls: "bg-teal-50 text-teal-700 ring-1 ring-teal-200" },
  ai_design_tool:    { label: "AI Design Tool",    cls: "bg-lime-50 text-lime-700 ring-1 ring-lime-200" },
  ai_other:          { label: "AI",                cls: "bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200" },
};

const PRICING_STYLE: Record<string, { label: string; cls: string }> = {
  free:           { label: "Free",     cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" },
  free_options:   { label: "Freemium", cls: "bg-sky-50 text-sky-700 ring-1 ring-sky-200" },
  paid:           { label: "Paid",     cls: "bg-neutral-100 text-neutral-700 ring-1 ring-neutral-300" },
  subscription:   { label: "订阅",     cls: "bg-amber-50 text-amber-700 ring-1 ring-amber-200" },
  free_trial:     { label: "Free Trial", cls: "bg-rose-50 text-rose-700 ring-1 ring-rose-200" },
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

function tryHostFromUrl(url: string | undefined | null): string {
  if (!url) return "";
  try { return new URL(url).host; } catch { return ""; }
}

interface Props {
  item: Item;
}

type TabState = "translated" | "original";

export function PhDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<PhMetrics>(item.metrics) ?? ({} as PhMetrics);
  const media = parseMedia(item.media);

  const name = item.title || "?";
  const tagline = item.content || "";
  const taglineTranslated = item.content_translated || "";
  const dailyRank = (extra as { daily_rank?: number }).daily_rank;
  const launchDate = extra.launch_date_pt || "";
  const phUrl = extra.ph_url || item.url || "";
  const websiteUrl = (extra.website_url as string) || "";
  const aiCategory = (extra.ai_category as string) || "";
  const catStyle = AI_CATEGORY_STYLE[aiCategory];
  const aiSummary = (extra.ai_summary as string) || "";

  const logo = media.find((m) => (m as MediaItem & { role?: string }).role === "logo");
  const galleryItems = media.filter((m) => (m as MediaItem & { role?: string }).role !== "logo");

  const makers = (extra.makers as Array<{ name?: string; handle?: string; avatar_url?: string; profile_url?: string }>) || [];
  const hunter = (extra.hunter as { name?: string; handle?: string; avatar_url?: string }) || null;
  const makerHandles = useMemo(() => new Set(makers.map((m) => m.handle).filter(Boolean) as string[]), [makers]);

  const makerPost = (extra.maker_post as PhComment) || null;
  const makerPostText = (extra.maker_post_text as string) || makerPost?.text || "";
  const makerPostTranslated = (extra.maker_post_translated as string) || "";

  const topComments = (extra.top_comments as PhComment[]) || [];
  const topReviews = (extra.top_reviews as PhReview[]) || [];

  const pricingType = (extra.pricing_type as string) || metrics.pricing_type || "";
  const isOpenSource = !!extra.is_open_source;
  const pricingStyle = PRICING_STYLE[pricingType];

  // Tab state for translation toggle
  const [makerTab, setMakerTab] = useState<TabState>("translated");
  const [commentTab, setCommentTab] = useState<TabState>("translated");
  const [reviewTab, setReviewTab] = useState<TabState>("translated");

  // Lightbox
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxMedia = galleryItems.map((m) => ({ type: m.type === "video" ? "video" : "image", url: m.url } as MediaItem));

  return (
    <div className="text-neutral-900">
      {/* ① 产品头部 */}
      <div className="border-b border-neutral-100 p-5" data-drawer-title-anchor>
        <div className="flex items-start gap-3">
          {logo?.url ? (
            <img
              src={logo.url}
              alt={name}
              className="h-16 w-16 shrink-0 rounded-2xl bg-neutral-200 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <div className="h-16 w-16 shrink-0 rounded-2xl bg-neutral-200" />
          )}
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-1.5 text-[12px] text-neutral-500">
              {dailyRank !== undefined && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 font-medium tabular-nums text-amber-700 ring-1 ring-amber-200">
                  #{dailyRank}
                </span>
              )}
              {launchDate && <span>· {launchDate} PT</span>}
            </div>
            <div className="text-[18px] font-bold leading-tight text-neutral-900 break-words">
              {name}
            </div>
            <div className="mt-0.5 text-[14px] text-neutral-600">
              {taglineTranslated || tagline}
            </div>
          </div>
        </div>

        {/* 类别 chip */}
        {catStyle && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", catStyle.cls)}>
              {catStyle.label}
            </span>
          </div>
        )}

        {/* 官网弱链接 */}
        {websiteUrl && (
          <div className="mt-3 text-[12px] text-neutral-500">
            官网：
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 hover:text-sky-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {tryHostFromUrl(websiteUrl) || websiteUrl}↗
            </a>
          </div>
        )}
      </div>

      {/* ② KPI 行 */}
      {(metrics.votes !== undefined || metrics.comments !== undefined || metrics.reviews_count !== undefined || metrics.followers !== undefined) && (
        <div className="grid grid-cols-4 gap-2 border-b border-neutral-100 px-5 py-3 text-center">
          {metrics.votes !== undefined && (
            <Kpi label="votes" value={`▲ ${formatCompact(metrics.votes)}`} />
          )}
          {metrics.comments !== undefined && (
            <Kpi label="comments" value={`💬 ${formatCompact(metrics.comments)}`} />
          )}
          {metrics.reviews_count !== undefined && metrics.reviews_count > 0 && (
            <Kpi
              label={`${metrics.reviews_count} reviews`}
              value={`⭐ ${metrics.reviews_avg !== undefined ? metrics.reviews_avg.toFixed(2) : "-"}`}
            />
          )}
          {metrics.followers !== undefined && (
            <Kpi label="followers" value={`👥 ${formatCompact(metrics.followers)}`} />
          )}
        </div>
      )}

      {/* ③ Gallery 横滑 */}
      {galleryItems.length > 0 && (
        <div className="border-b border-neutral-100 py-4">
          <div className="mb-2 px-5 text-[11px] font-semibold text-neutral-700">截图与视频</div>
          <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-5">
            {galleryItems.map((m, i) =>
              m.type === "video" ? (
                <video
                  key={i}
                  src={m.url}
                  className="h-48 w-72 shrink-0 snap-start rounded-lg bg-neutral-200 object-cover"
                  controls
                  preload="metadata"
                />
              ) : (
                <img
                  key={i}
                  src={m.url}
                  className="h-48 w-72 shrink-0 cursor-zoom-in snap-start rounded-lg bg-neutral-200 object-cover"
                  loading="lazy"
                  alt=""
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex(i);
                  }}
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              )
            )}
          </div>
        </div>
      )}

      {/* ④ AI 解读 */}
      {aiSummary && (
        <div className="border-b border-neutral-100 bg-neutral-50/40 p-5">
          <p className="text-[14px] leading-relaxed text-neutral-800">{aiSummary}</p>
        </div>
      )}

      {/* ⑤ Maker post */}
      {makerPostText && (
        <div className="border-b border-neutral-100 p-5">
          <div className="mb-2.5 flex items-center gap-2">
            {makerPost?.avatar_url && (
              <img
                src={makerPost.avatar_url}
                alt={makerPost.author_name || ""}
                className="h-9 w-9 rounded-full bg-neutral-200 object-cover"
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="text-[14px] font-semibold text-neutral-900">
                  {makerPost?.author_name || makers[0]?.name}
                </span>
                {makerPost?.author_handle && (
                  <span className="text-[12px] text-neutral-500">@{makerPost.author_handle}</span>
                )}
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                  MAKER
                </span>
              </div>
            </div>
            {makerPostTranslated && (
              <TranslateToggle tab={makerTab} onChange={setMakerTab} />
            )}
          </div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-700">
            {makerTab === "translated" && makerPostTranslated ? makerPostTranslated : makerPostText}
          </p>
        </div>
      )}

      {/* ⑥ 团队 + Hunter */}
      {(makers.length > 0 || hunter) && (
        <div className="border-b border-neutral-100 p-5">
          <h3 className="mb-2.5 text-[13px] font-semibold text-neutral-700">团队 & Hunter</h3>
          <div className="flex flex-wrap gap-3">
            {makers.map((m, i) => (
              <PersonBadge key={i} person={m} role="Maker" />
            ))}
            {hunter && <PersonBadge person={hunter} role="Hunter" />}
          </div>
        </div>
      )}

      {/* ⑦ Top Reviews */}
      {topReviews.length > 0 && (
        <div className="border-b border-neutral-100 p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[13px] font-semibold text-neutral-700">
              {metrics.reviews_avg !== undefined && `⭐ ${metrics.reviews_avg.toFixed(2)} · `}
              {metrics.reviews_count ?? topReviews.length} reviews
            </h3>
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
                  className="text-[11px] text-sky-600 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  在 PH 看全部 ↗
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⑧ Top 10 评论 */}
      {topComments.length > 0 && (
        <div className="border-b border-neutral-100 p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[13px] font-semibold text-neutral-700">
              💬 Top 评论 · 共 {metrics.comments ?? topComments.length}
            </h3>
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
                  className="text-[11px] text-sky-600 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  查看全部 {metrics.comments ?? "..."} 条评论 ↗
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⑨ 更多 + Pricing */}
      <div className="border-b border-neutral-100 p-5">
        <h3 className="mb-2 text-[13px] font-semibold text-neutral-700">更多</h3>
        <div className="space-y-2">
          {phUrl && (
            <a
              href={`${phUrl.replace("/products/", "/p/")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 hover:bg-neutral-50"
              onClick={(e) => e.stopPropagation()}
            >
              <div>
                <div className="text-[13px] font-medium text-neutral-900">论坛深度讨论</div>
                <div className="text-[11px] text-neutral-500">PH 论坛页 (二期接入)</div>
              </div>
              <span className="text-neutral-400">↗</span>
            </a>
          )}
          {phUrl && (
            <a
              href={`${phUrl}/alternatives`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 hover:bg-neutral-50"
              onClick={(e) => e.stopPropagation()}
            >
              <div>
                <div className="text-[13px] font-medium text-neutral-900">类似产品</div>
                <div className="text-[11px] text-neutral-500">在 PH 看 alternatives</div>
              </div>
              <span className="text-neutral-400">↗</span>
            </a>
          )}
        </div>

        {/* Pricing */}
        {(pricingStyle || isOpenSource) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-500">
            {pricingStyle && (
              <span className={cn("rounded-full px-2 py-0.5 font-medium", pricingStyle.cls)}>
                {pricingStyle.label}
              </span>
            )}
            {isOpenSource && (
              <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700 ring-1 ring-violet-200">
                开源
              </span>
            )}
            {dailyRank !== undefined && (
              <span className="ml-auto">{ordinal(dailyRank)} on PH</span>
            )}
          </div>
        )}
      </div>

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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[16px] font-bold tabular-nums text-neutral-900">{value}</div>
      <div className="text-[10px] text-neutral-500">{label}</div>
    </div>
  );
}

function TranslateToggle({ tab, onChange }: { tab: TabState; onChange: (t: TabState) => void }) {
  return (
    <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onChange("translated"); }}
        className={cn(
          "rounded px-2 py-0.5 text-[11px]",
          tab === "translated" ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600",
        )}
      >
        译文
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onChange("original"); }}
        className={cn(
          "rounded px-2 py-0.5 text-[11px]",
          tab === "original" ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600",
        )}
      >
        原文
      </button>
    </div>
  );
}

function PersonBadge({ person, role }: { person: { name?: string; handle?: string; avatar_url?: string; profile_url?: string }; role: string }) {
  return (
    <div className="flex items-center gap-2">
      {person.avatar_url ? (
        <img
          src={person.avatar_url}
          alt={person.name || ""}
          className="h-8 w-8 rounded-full bg-neutral-200 object-cover"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      ) : (
        <div className="h-8 w-8 rounded-full bg-neutral-200" />
      )}
      <div>
        <div className="text-[13px] font-medium text-neutral-900">{person.name}</div>
        <div className="text-[11px] text-neutral-500">
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
  return (
    <div className="rounded-lg bg-neutral-50 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        {review.avatar_url ? (
          <img src={review.avatar_url} alt="" className="h-6 w-6 rounded-full bg-neutral-300 object-cover" />
        ) : (
          <div className="h-6 w-6 rounded-full bg-neutral-300" />
        )}
        <span className="text-[12px] font-medium text-neutral-900">{review.author_name}</span>
        {stars && <span className="text-[11px] text-amber-500">{stars}</span>}
      </div>
      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-700">{body}</p>
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
  const body = tab === "translated" && comment.translated ? comment.translated : comment.text || "";
  const isMaker = !!comment.author_handle && makerHandles.has(comment.author_handle);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        {comment.avatar_url ? (
          <img src={comment.avatar_url} alt="" className="h-7 w-7 rounded-full bg-neutral-300 object-cover" />
        ) : (
          <div className="h-7 w-7 rounded-full bg-neutral-300" />
        )}
        <span className="text-[13px] font-medium text-neutral-900">{comment.author_name}</span>
        {comment.author_handle && (
          <span className="text-[11px] text-neutral-500">@{comment.author_handle}</span>
        )}
        {isMaker && (
          <span className="rounded bg-violet-100 px-1 py-0 text-[10px] font-semibold text-violet-700">MAKER</span>
        )}
      </div>
      <p className="ml-9 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-700">{body}</p>
      {comment.upvotes !== undefined && comment.upvotes !== null && (
        <div className="ml-9 mt-1 text-[11px] text-neutral-500">▲ {comment.upvotes}</div>
      )}
    </div>
  );
}

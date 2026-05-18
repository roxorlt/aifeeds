// HuggingFace Daily Paper feed card — Phase 0 mockup
//
// 字段与布局来源：docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md §6.5
// 视觉基线对齐 PhCard / GithubCard（YouTube 风格：hero thumbnail 顶部，正文
// + 元信息 + footer 跨整张卡宽），按 docs/frontend-ux-guidelines.md token：
//   - 卡片 px-4 py-3 hover:bg-neutral-50/60 border-b 无 shadow
//   - 标题 text-[15px] font-bold，副标题 text-[13px] text-neutral-500
//   - chip bg-neutral-100 text-neutral-700 text-[11px]
//   - novelty 实心 ★ 用 amber-500，空心用 neutral-300
//
// emoji 严禁当 icon（CLAUDE.md / SOP §5.F）—— ▲/💬/⭐ 全部走 inline SVG。

import { useState } from "react";
import type { HfPaperMetrics, Item, ItemExtra } from "../types";
import { formatCompact, parseJsonField, timeAgo } from "../lib/utils";
import { useDrawer } from "../lib/drawer";

interface Props {
  item: Item;
}

// ─── Inline icons (HF feed specific) ──────────────────────────────────────
// lucide-react 的 ArrowBigUp / MessageSquare / Star 抽出来手写避免引入新依赖
function IconUpvoteTri({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 2.5l5.5 7H2.5l5.5-7z" />
    </svg>
  );
}

function IconCommentSquare({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 4h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H3a1 1 0 01-1-1V5a1 1 0 011-1z" />
    </svg>
  );
}

function IconStarFilled({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 1l2.2 4.6 5 .7-3.6 3.5.9 5L8 12.3 3.5 14.8l.9-5L.8 6.3l5-.7L8 1z" />
    </svg>
  );
}

function IconStarHollow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M8 1l2.2 4.6 5 .7-3.6 3.5.9 5L8 12.3 3.5 14.8l.9-5L.8 6.3l5-.7L8 1z" />
    </svg>
  );
}

function IconArrowOut({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M5 3h8v8M13 3L5 11" />
    </svg>
  );
}

export function NoveltyStars({
  rating,
  size = "sm",
}: {
  rating: number;
  size?: "sm" | "lg";
}) {
  const safe = Math.max(0, Math.min(5, Math.round(rating || 0)));
  const cls = size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5";
  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={`新颖度 ${safe}/5`}
      title={`AI 新颖度评分 ${safe}/5`}
    >
      {Array.from({ length: 5 }).map((_, i) =>
        i < safe ? (
          <IconStarFilled key={i} className={`${cls} text-amber-500`} />
        ) : (
          <IconStarHollow key={i} className={`${cls} text-neutral-300`} />
        ),
      )}
    </span>
  );
}

export function HfPaperCard({ item }: Props) {
  const drawer = useDrawer();
  const [coverFailed, setCoverFailed] = useState(false);
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<HfPaperMetrics>(item.metrics) ?? ({} as HfPaperMetrics);

  // 优先中译，缺时退到原文
  const title = extra.title_zh || item.title || "";
  const aiSummaryZh = extra.ai_summary_zh || "";
  const keywords = (extra.ai_keywords || []).slice(0, 3);
  const novelty = extra.deep_analysis?.novelty_rating;

  // thumbnail：HF 提供 1200×630 social-thumbnail（cdn-thumbnails.huggingface.co）
  // Phase 1 BE 会把 cdn-thumbnails / cdn-avatars 加进 worker /img PROXY_HOSTS
  // 走 cf.image webp/avif 反代。mockup 阶段直拉 CDN（可能 CN 略慢但可加载）。
  const media = Array.isArray(item.media) ? item.media : [];
  const cover = media.find((m) => m.type === "image");

  // submitter：HF 用户名（@xxx）+ 头像 + 提交日期相对时间
  const submitter = extra.submitted_by;
  const submittedAt = extra.submitted_on_daily_at || item.published_at;
  const relTime = timeAgo(submittedAt);

  const upvotes = metrics.upvotes;
  const numComments = metrics.num_comments;
  const githubStars = metrics.github_stars ?? extra.github_stars;

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      {/* Cover thumbnail — 1200×630 HF social card；占满卡宽，rounded-2xl 跟
          PhCard / LinkCard 一致。挂了就隐藏（不留空白），avatar/手写降级方案 */}
      {cover && !coverFailed && (
        <div className="mb-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100">
          <img
            src={cover.url}
            alt=""
            loading="lazy"
            className="aspect-[1200/630] w-full object-cover"
            onError={() => setCoverFailed(true)}
          />
        </div>
      )}

      {/* 标题（中译）— 跟 PhCard tagline 同字号（15px font-bold），允许 2 行 clamp。
          中译缺失时退到英文原标题（rare 但要 graceful）。 */}
      <h3 className="line-clamp-2 text-[15px] font-bold leading-tight text-neutral-900 break-words">
        {title}
      </h3>

      {/* HF AI 一句话摘要（中译）— 单行 truncate，跟标题区分用 neutral-600 + smaller */}
      {aiSummaryZh && (
        <p className="mt-1 line-clamp-1 text-[13px] text-neutral-600 break-words">
          {aiSummaryZh}
        </p>
      )}

      {/* AI Keywords chip 行 — 前 3 个 */}
      {keywords.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {keywords.map((kw) => (
            <span
              key={kw}
              className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700"
            >
              #{kw}
            </span>
          ))}
        </div>
      )}

      {/* Metrics 行 — ▲ upvotes · 💬 comments · ⭐ GH stars。无值的指标整列省略。
          跟 PhCard 同款 inline-flex + gap-1 + tabular-nums 排版。 */}
      {(upvotes !== undefined || numComments !== undefined || githubStars !== undefined) && (
        <div className="mt-2 flex items-center gap-x-3 text-[13px] text-neutral-500">
          {upvotes !== undefined && (
            <span className="inline-flex items-center gap-1" aria-label="upvotes">
              <IconUpvoteTri className="h-3.5 w-3.5" />
              <span className="tabular-nums">{formatCompact(upvotes)}</span>
            </span>
          )}
          {numComments !== undefined && (
            <span className="inline-flex items-center gap-1" aria-label="comments">
              <IconCommentSquare className="h-3.5 w-3.5" />
              <span className="tabular-nums">{formatCompact(numComments)}</span>
            </span>
          )}
          {githubStars !== undefined && githubStars !== null && (
            <span className="inline-flex items-center gap-1" aria-label="github stars">
              <IconStarFilled className="h-3.5 w-3.5 text-amber-500" />
              <span className="tabular-nums">{formatCompact(githubStars)}</span>
            </span>
          )}
        </div>
      )}

      {/* Submitter 行 — 左：avatar + @handle + 相对时间；右：novelty 星条。
          ★ 评分独立显示在卡片右下角（handoff §6.1 决定不进 8 维度列表）。 */}
      <div className="mt-2 flex items-center justify-between gap-3 text-[13px] text-neutral-500">
        <div className="flex min-w-0 items-center gap-1.5">
          {submitter?.avatar_url ? (
            <img
              src={submitter.avatar_url}
              alt={submitter.user}
              className="h-5 w-5 shrink-0 rounded-full bg-neutral-200 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <span className="h-5 w-5 shrink-0 rounded-full bg-neutral-200" />
          )}
          {submitter?.user && (
            <span className="truncate">
              by <span className="text-neutral-700">@{submitter.user}</span>
              {relTime && (
                <>
                  <span className="mx-1 text-neutral-400">·</span>
                  <span className="text-neutral-500">{relTime}</span>
                </>
              )}
            </span>
          )}
        </div>
        {novelty !== undefined && novelty !== null && (
          <NoveltyStars rating={novelty} />
        )}
      </div>

      {/* CTA 「拆解阅读」 — 整张卡片本身 clickable（onClick=open），CTA 主要做
          视觉 affordance 提示用户"还有深度内容"。click 也走 open。
          stopPropagation 避免双触发（虽然结果一致，行为更明确）。 */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
        >
          拆解阅读
          <IconArrowOut className="h-3 w-3" />
        </button>
      </div>
    </article>
  );
}

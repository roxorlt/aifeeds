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
import { resolveAssetUrl } from "../lib/asset";
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
  // PM v6.7: 正文用 deep_analysis.tldr(2-3 句的 TL;DR 描述,信息量比 ai_summary_zh
  // 一句话更够)。不带 "TL;DR" 前缀,直接显示纯内容。deep_analysis 还没生成时
  // fallback 到 ai_summary_zh
  const summary = extra.deep_analysis?.tldr || extra.ai_summary_zh || "";
  const keywords = (extra.ai_keywords || []).slice(0, 3);

  // thumbnail：HF 提供 1200×630 social-thumbnail（cdn-thumbnails.huggingface.co）
  // Phase 1 BE 会把 cdn-thumbnails / cdn-avatars 加进 worker /img PROXY_HOSTS
  // 走 cf.image webp/avif 反代。mockup 阶段直拉 CDN（可能 CN 略慢但可加载）。
  const media = Array.isArray(item.media) ? item.media : [];
  const cover = media.find((m) => m.type === "image");

  // submitter：HF 用户名（@xxx）+ 头像 + 提交日期相对时间
  // PM v3: 多作者时显示 "by @xxx 等 N 位"（N = 论文 paper_authors 总数）。
  // submitter ≠ 一定是 author,但 PM 想在卡片暴露作者规模信息,文案做条件式。
  const submitter = extra.submitted_by;
  const submittedAt = extra.submitted_on_daily_at || item.published_at;
  const relTime = timeAgo(submittedAt);
  const authorsCount = (extra.paper_authors || []).length;

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
            src={resolveAssetUrl(cover.url)}
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

      {/* TL;DR（中译）— 最多 4 行 clamp,超出 ……。跟标题区分用 neutral-600 + smaller */}
      {summary && (
        <p className="mt-1 line-clamp-4 text-[13px] leading-[1.5] text-neutral-600 break-words">
          {summary}
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

      {/* Footer 行 — 左：metrics(▲ upvotes · 💬 comments · ⭐ GH stars)；右：submitter avatar + by @handle · 相对时间。
          单行排布,左右对齐(PM v2 反馈:合并到同一行;砍掉 ★ novelty 与「拆解阅读」CTA)。 */}
      <div className="mt-2.5 flex items-center justify-between gap-3 text-[13px] text-neutral-500">
        {/* 左:metrics */}
        <div className="flex shrink-0 items-center gap-x-3">
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
        {/* 右:submitter avatar + @handle · 时间。flex-1 + min-w-0 + justify-end 让长 handle 也会优先 truncate */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {submitter?.avatar_url ? (
            <img
              src={resolveAssetUrl(submitter.avatar_url)}
              alt={submitter.user}
              loading="lazy"
              decoding="async"
              className="h-5 w-5 shrink-0 rounded-full bg-neutral-200 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <span className="h-5 w-5 shrink-0 rounded-full bg-neutral-200" />
          )}
          {submitter?.user && (
            // PM v6.3: 只 truncate handle 部分,其他("等 N 位 · X 天前")必须完整露出。
            // handle 给 max-w-[100px] 上限,超长则 ellipsis,例如:
            //   "by @caiyuchen... 等 12 位 · 1 天前"
            // min-w-0 让外层 flex 容器允许 handle 子项 shrink。
            <span className="inline-flex min-w-0 items-baseline">
              <span className="shrink-0">by&nbsp;</span>
              <span className="inline-block max-w-[100px] truncate text-neutral-700 align-bottom">
                @{submitter.user}
              </span>
              {authorsCount > 1 && (
                <span className="shrink-0 text-neutral-500">
                  &nbsp;等 {authorsCount} 位
                </span>
              )}
              {relTime && (
                <>
                  <span className="mx-1 shrink-0 text-neutral-400">·</span>
                  <span className="shrink-0 text-neutral-500">{relTime}</span>
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

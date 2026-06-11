// Blog (AI 厂商官方博客) feed card.
//
// 设计：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §10.2（用户已定 ②）
// 视觉家族：news-card 式 —— 文字为主 + 右侧小缩略图（~96×96 圆角），非满宽 hero。
// token 对齐 docs/frontend-ux-guidelines.md / GithubCard：
//   - 卡片 px-4 py-3 hover:bg-neutral-50/60 border-b 无 shadow 无 rounded
//   - 标题 text-[15px] font-bold（2 行 clamp）/ ELI25 摘要 text-[13px] neutral-600（3 行 clamp）
//   - byline：[publisher logo] OpenAI · 6 天前 · 约 5 分钟 [分类 chip]
//   - 无互动数行（RSS 无 star/vote），用「阅读时长」当 meta 替代
//   - emoji 严禁当 icon —— 时钟走 icons.tsx 的 IconClock（lucide 风 SVG）
//
// publisher logo：命中 R2（extra.publisher.icon_r2）用真实 logo，未命中降级首字母 monogram。
// 右侧缩略图：质量门控（ar>2 ‖ ar<0.5 ‖ maxDim<240）滤低质图，无图则纯文字不留位。
//
// 注：blog/podcast 无 metrics，不挂 useImpressionRefresh（无 refresh-metrics cron）。

import { useState } from "react";
import type { Item, ItemExtra } from "../types";
import { parseJsonField, proxyImg, timeAgo } from "../lib/utils";
import { resolveAssetUrl } from "../lib/asset";
import { useDrawer } from "../lib/drawer";
import { IconClock } from "./icons";

interface Props {
  item: Item;
  // 首屏前几张卡(Feed 传入):封面图 eager + fetchPriority=high,LCP 优化
  eager?: boolean;
}

// blog ai_category（§8.4.A）→ 中文标签。与 GH 的 agent/model/... 不同枚举，
// 各卡片只 switch 自己取值，不匹配落 undefined（不渲染 chip）。
const BLOG_CATEGORY_LABEL: Record<string, string> = {
  "model-release": "模型发布",
  research: "研究",
  product: "产品",
  engineering: "工程",
  safety: "安全",
  company: "公司",
  // 'other' 故意不映射 → 不渲染 chip（零信号，避免 byline 噪音；mockup 也只显有效分类）
};

// monogram fallback 取色：按 publisher 名 hash 取一档固定彩色（logo 是唯一允许
// 出现品牌色的地方）。零网络、永远可渲染。
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

export function BlogCard({ item, eager }: Props) {
  const drawer = useDrawer();
  const [coverFailed, setCoverFailed] = useState(false);
  // onLoad 后检测真实 natural dims，aspect 极端 / 太小视为低质图（同 GithubCard /
  // worker share/handlers.ts 门控），降级纯文字。
  const [coverRejected, setCoverRejected] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);

  // 标题优先中译，缺时退原文。ELI25 摘要优先 ai_summary_zh（§8.4.A），逐级降级。
  const title = extra.title_zh || item.title || "";
  const summary =
    extra.ai_summary_zh ||
    extra.excerpt_zh ||
    extra.excerpt ||
    item.content_translated ||
    item.content ||
    "";

  const publisherName =
    extra.publisher?.name ||
    extra.source_company ||
    extra.blog_name ||
    item.author ||
    "";
  const logoUrl = extra.publisher?.icon_r2
    ? resolveAssetUrl(extra.publisher.icon_r2)
    : "";

  const time = timeAgo(item.published_at);
  const readingMinutes =
    typeof extra.reading_minutes === "number" && extra.reading_minutes > 0
      ? extra.reading_minutes
      : null;
  const categoryLabel = extra.ai_category
    ? BLOG_CATEGORY_LABEL[extra.ai_category as string]
    : undefined;

  const coverImage = extra.cover_image || "";

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex items-start gap-3">
        {/* 左：文字主体 */}
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[15px] font-bold leading-tight text-neutral-900 break-words">
            {title}
          </h3>

          {summary && (
            <p className="mt-1 line-clamp-3 text-[13px] leading-[1.5] text-neutral-600 break-words">
              {summary}
            </p>
          )}

          {/* byline：logo + 厂商 · 时间 · 阅读时长 + 分类 chip。无互动数行。 */}
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-neutral-500">
            {logoUrl && !logoFailed ? (
              <img
                src={logoUrl}
                alt={publisherName}
                loading="lazy"
                decoding="async"
                className="h-5 w-5 shrink-0 rounded-md bg-white object-cover ring-1 ring-neutral-200"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white"
                style={{ background: monoColor(publisherName || "blog") }}
                aria-hidden="true"
              >
                {monoLetter(publisherName)}
              </span>
            )}
            {publisherName && (
              <span className="shrink-0 font-medium text-neutral-700">{publisherName}</span>
            )}
            {time && (
              <>
                <span className="shrink-0 text-neutral-400">·</span>
                <span className="shrink-0 whitespace-nowrap">{time}</span>
              </>
            )}
            {readingMinutes !== null && (
              <>
                <span className="shrink-0 text-neutral-400">·</span>
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
                  <IconClock className="h-3.5 w-3.5" />约 {readingMinutes} 分钟
                </span>
              </>
            )}
            {categoryLabel && (
              <span className="shrink-0 whitespace-nowrap rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                {categoryLabel}
              </span>
            )}
          </div>
        </div>

        {/* 右：~96×96 圆角缩略图（质量门控；无图则纯文字不留位） */}
        {coverImage && !coverFailed && !coverRejected && (
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
            <img
              src={proxyImg(coverImage, 240)}
              alt=""
              loading={eager ? "eager" : "lazy"}
              fetchPriority={eager ? "high" : undefined}
              decoding="async"
              className="h-full w-full object-cover"
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
          </div>
        )}
      </div>
    </article>
  );
}

// BE PR5 (2026-05-21): X Article 渲染卡片
//
// 数据源: extra.{path}.x_article (BE 走 ScrapeBadger 抓 X Article 内容)
// + content_resolved_url (PR4 BE 同 path 已有)
//
// 3 tier 渲染策略 (BE 建议):
// - Rich:  x_article.fetched_at && x_article.title
//   → cover + title + excerpt + author (X 流内同款)
// - Mid:   x_article.fetch_failed_at && x_article.author_handle
//   → "📄 X 文章 by @handle ↗" + URL (老 article SB 反索引只剩 author)
// - Basic: 其他 (含 !x_article) → 当前 TcoResolvedLinkCard (裸 URL link 卡条)

import { useState } from "react";
import type { XArticle } from "../types";
import { proxyImg } from "../lib/utils";
import { TcoResolvedLinkCard } from "./TcoResolvedLinkCard";

export type ArticleTier = "rich" | "mid" | "basic";

export function articleTier(a: XArticle | null | undefined): ArticleTier {
  if (!a) return "basic";
  if (a.fetched_at && a.title) return "rich";
  if (a.fetch_failed_at && a.author_handle) return "mid";
  return "basic";
}

interface Props {
  article: XArticle | null | undefined;
  // content_resolved_url — 兜底卡片需要(Mid/Basic 都用)
  resolvedUrl: string | null | undefined;
  // 原裸 content(给 Basic tier 用 TcoResolvedLinkCard fallback)
  content: string | null | undefined;
  // 嵌套 quote 小卡 / modal 内更紧凑布局
  compact?: boolean;
}

export function XArticleCard({ article, resolvedUrl, content, compact }: Props) {
  const tier = articleTier(article);
  const url = resolvedUrl || undefined;
  const [coverFailed, setCoverFailed] = useState(false);

  // Basic — 复用 PR4 简化卡(纯 URL)
  if (tier === "basic") {
    return <TcoResolvedLinkCard content={content} resolvedUrl={resolvedUrl} compact={compact} />;
  }

  // Mid — 老 article 只有 author 信息
  if (tier === "mid" && article) {
    const handle = article.author_handle || "";
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={
          compact
            ? "mt-1 inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-neutral-200 bg-neutral-50/60 px-2 py-1 text-[12px] text-neutral-700 hover:bg-neutral-100"
            : "mt-2 inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-neutral-200 bg-neutral-50/60 px-2.5 py-1.5 text-[13px] text-neutral-700 hover:bg-neutral-100"
        }
      >
        <span className="shrink-0">📄</span>
        <span className="shrink-0 font-medium">X 文章</span>
        {handle && (
          <span className="shrink-0 text-neutral-500">by @{handle}</span>
        )}
        {url && <span className="truncate text-neutral-500">{url}</span>}
        <span className="shrink-0 text-neutral-400">↗</span>
      </a>
    );
  }

  // Rich — 完整 X Article 卡片 (对齐 X 流内样式)
  // - cover 大图 16:9 全宽 + 左下 "X 文章" chip
  // - title 粗体 line-clamp-2
  // - 作者行 「by @handle」
  // - excerpt line-clamp-3
  if (!article) return null;
  const cover = article.cover_image_url;
  const title = article.title || "";
  const excerpt = article.excerpt || "";
  const authorName = article.author_name || "";
  const authorHandle = article.author_handle || "";

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={
        compact
          ? "mt-2 block overflow-hidden rounded-xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50"
          : "mt-2.5 block overflow-hidden rounded-2xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50"
      }
    >
      {cover && !coverFailed && (
        <div className="relative w-full overflow-hidden bg-neutral-100" style={{ aspectRatio: "16 / 9" }}>
          <img
            src={proxyImg(cover, 800)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setCoverFailed(true)}
          />
          {/* 左下角 "X 文章" chip(对齐 X app 样式) */}
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur">
            <span>𝕏</span>
            <span>文章</span>
          </span>
        </div>
      )}
      <div className={compact ? "p-2.5" : "p-3"}>
        {title && (
          <div
            className={
              compact
                ? "line-clamp-2 break-words text-[13px] font-semibold leading-[1.35] text-neutral-900"
                : "line-clamp-2 break-words text-[15px] font-semibold leading-[1.35] text-neutral-900"
            }
          >
            {title}
          </div>
        )}
        {(authorName || authorHandle) && (
          <div className="mt-1 truncate text-[12px] text-neutral-500">
            by {authorName}
            {authorHandle && <span className="ml-1">@{authorHandle}</span>}
          </div>
        )}
        {excerpt && (
          <div
            className={
              compact
                ? "mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-[1.5] text-neutral-700"
                : "mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-neutral-700"
            }
          >
            {excerpt}
          </div>
        )}
      </div>
    </a>
  );
}

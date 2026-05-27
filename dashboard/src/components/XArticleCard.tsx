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

import { useState, type MouseEvent as ReactMouseEvent } from "react";
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
  // BE PR6 (2026-05-25): 展示 body 全文 (默认 false)。
  // - 流内 (TweetCard L1 / QuotedTweet nested) 不传 — 保持紧凑预览
  // - QuoteSnapshotModal 内传 true — 用户进 modal 是想读全文
  // body 区域有独立交互(展开/收起),内部 click 不冒泡到外层 <a> 跳 X
  showBody?: boolean;
}

const BODY_COLLAPSED_CHARS = 600;   // body 短于这个长度直接全显;否则 line-clamp

export function XArticleCard({ article, resolvedUrl, content, compact, showBody }: Props) {
  const tier = articleTier(article);
  const url = resolvedUrl || undefined;
  const [coverFailed, setCoverFailed] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);

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
  // BE PR #112 (2026-05-22): 优先取翻译,fallback 原文。
  // - 英文 article + 翻译成功 → 显示中文 title_translated/excerpt_translated
  // - 中文 article (translate_skipped_at 有) → 翻译字段为空 → fallback 原文中文
  // - 翻译失败 (translate_failed_at) → 同样 fallback 原文
  const title = article.title_translated || article.title || "";
  const excerpt = article.excerpt_translated || article.excerpt || "";
  const authorName = article.author_name || "";
  const authorHandle = article.author_handle || "";

  // Body render chain (BE PR6):
  //   body_translated > body (英文兜底也能读)
  // sentinel 判断 (UI 友好提示):
  //   - body_translate_skipped_at: body > 15000 chars 跳过翻译,显原文 + 灰字提示
  //   - translate_failed_at + body 有: 翻译 timeout/parse fail,显原文 + 灰字
  //   - body_fetch_failed_at: 没 body 数据,body section 不渲染
  const bodyRaw = article.body_translated || article.body || "";
  const bodyShown = Boolean(showBody && bodyRaw);
  const bodyIsOriginal = !article.body_translated && Boolean(article.body);
  const bodyTooLongToTranslate = Boolean(article.body_translate_skipped_at);
  const bodyTranslateFailed = Boolean(article.translate_failed_at) && bodyIsOriginal;
  const bodyNeedsClamp = bodyRaw.length > BODY_COLLAPSED_CHARS;
  const stopLinkNav = (e: ReactMouseEvent) => {
    // body section 整体阻断 — 用户点 body 是想读 body,不应跳 X
    e.stopPropagation();
    e.preventDefault();
  };

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
        {/* Body 全文 (showBody=true 才显;modal 内场景) */}
        {bodyShown && (
          <div
            className="mt-3 border-t border-neutral-100 pt-3"
            onClick={stopLinkNav}
          >
            {/* sentinel 灰字提示 — 翻译失败 / body 超长跳过翻译时告知用户在看原文 */}
            {(bodyTooLongToTranslate || bodyTranslateFailed) && (
              <div className="mb-2 text-[11px] text-neutral-400">
                {bodyTooLongToTranslate
                  ? "原文较长未翻译,以下为英文原文"
                  : "翻译失败,以下为英文原文"}
              </div>
            )}
            <div
              className={
                "whitespace-pre-wrap break-words text-[14px] leading-[1.6] text-neutral-800" +
                (bodyNeedsClamp && !bodyExpanded ? " line-clamp-[8]" : "")
              }
            >
              {bodyRaw}
            </div>
            {bodyNeedsClamp && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setBodyExpanded((v) => !v);
                }}
                className="mt-1.5 text-[13px] font-medium text-sky-600 hover:text-sky-700"
              >
                {bodyExpanded ? "收起" : "展开全文"}
              </button>
            )}
          </div>
        )}
        {/* body 抓取失败 (cookie 失效 / 老 article 死链) — 仅在 showBody 场景显小灰字,
            流内场景不打扰 */}
        {showBody && !bodyRaw && article.body_fetch_failed_at && (
          <div className="mt-3 border-t border-neutral-100 pt-3 text-[12px] text-neutral-400">
            原文正文暂时无法加载
          </div>
        )}
      </div>
    </a>
  );
}

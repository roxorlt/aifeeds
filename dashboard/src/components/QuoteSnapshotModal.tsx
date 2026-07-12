// PR3 嵌套引用小卡点击 → 站内 modal 显示 list DTO 中可用的 quote 快照
//
// 数据源:QuoteOf snapshot(来自 extra.quote_of / extra.retweet_of.quote_of)
// 不调 API。quote 推文可能不在 items 表(原 list 外账号),所以没独立 deeplink。
// list DTO 会截断嵌套正文并移除 X Article 全文；这里明确展示紧凑预览，完整内容
// 通过「在 X 打开」读取，避免弹窗暗示本地仍持有已从列表契约移除的全文。
//
// 视觉:
// - 移动端:从下方滑入,最大高度 90vh
// - 桌面端:居中卡片 max-w-[560px]
// - 点击背景 / ESC / 顶部 X 关闭
// - 翻译/原文 toggle(quote.content_translated 存在时)
// - 媒体网格(quote.media images)
// - "在 X 打开 ↗" 跳原推

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuoteSnapshotStore } from "../lib/quoteSnapshotStore";
import { proxyImg, timeAgo } from "../lib/utils";
import { VerifiedBadge, IconShare } from "./icons";
import { isTcoOnly } from "../lib/tcoResolvedLink";
import { XArticleCard } from "./XArticleCard";
import { useMotionDismiss } from "../lib/motionLayer";
import { activateModalFocus } from "../lib/modalFocus";
import { useScrollLock } from "../lib/useScrollLock";

export function QuoteSnapshotModal() {
  const quote = useQuoteSnapshotStore((s) => s.quote);
  const close = useQuoteSnapshotStore((s) => s.close);
  const [originalQuote, setOriginalQuote] = useState<typeof quote>(null);
  const showOriginal = originalQuote !== null && originalQuote === quote;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const modalOpen = Boolean(quote);
  const closeModal = useCallback(() => {
    setOriginalQuote(null);
    close();
  }, [close]);
  const { layerClassName, requestClose } = useMotionDismiss(closeModal, "sheet", Boolean(quote));
  const escapeCloseRef = useRef(closeModal);
  useScrollLock(modalOpen);

  useEffect(() => {
    escapeCloseRef.current = closeModal;
  }, [closeModal]);

  useEffect(() => {
    if (!modalOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    return activateModalFocus(panel, {
      onEscape: () => escapeCloseRef.current(),
    });
  }, [modalOpen]);

  if (!quote) return null;

  const handle = quote.handle || "";
  const author = quote.author || handle || "Unknown";
  const url =
    quote.id && handle ? `https://x.com/${handle}/status/${quote.id}` : "";
  const images = (quote.media || []).filter((m) => m.type === "image");
  const content = quote.content || "";
  const translated = quote.content_translated || "";
  const hasTranslation = Boolean(translated && translated !== content);
  const displayText = showOriginal || !hasTranslation ? content : translated;
  const m = quote.metrics || {};

  return (
    <div
      className={`${layerClassName} motion-layer-adaptive fixed inset-0 z-[60] flex items-end justify-center sm:items-center`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="quote-snapshot-title"
      onClick={requestClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="motion-layer-panel relative w-full max-w-[560px] overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl sm:max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <div className="flex h-9 items-center">
            <span id="quote-snapshot-title" className="text-sm font-semibold text-neutral-900">
              引用推文
            </span>
          </div>
          <button
            type="button"
            onClick={requestClose}
            data-modal-initial-focus
            className="-mr-1 flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 active:bg-neutral-200"
            aria-label="关闭"
          >
            <span className="text-base leading-none">✕</span>
          </button>
        </header>

        {/* Body — scroll within */}
        <div className="max-h-[calc(85vh-3rem)] overflow-y-auto overscroll-none px-4 py-3 sm:px-5">
          {/* Author row */}
          <div className="flex items-center gap-2">
            {quote.profile_image_url ? (
              <img
                src={proxyImg(quote.profile_image_url, 96)}
                alt=""
                loading="lazy"
                className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              />
            ) : (
              <div className="h-10 w-10 shrink-0 rounded-full bg-neutral-200" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-[15px] font-semibold text-neutral-900">
                  {author}
                </span>
                {Boolean(quote.is_verified) && (
                  <VerifiedBadge className="h-[15px] w-[15px] shrink-0 fill-sky-500" />
                )}
              </div>
              <div className="flex items-center gap-1 text-[13px] text-neutral-500">
                {handle && <span className="truncate">@{handle}</span>}
                {quote.published_at && (
                  <>
                    <span className="text-neutral-400">·</span>
                    <span className="shrink-0">{timeAgo(quote.published_at)}</span>
                  </>
                )}
              </div>
            </div>
            {/* 译文/原文 toggle —— 仅有翻译时 */}
            {hasTranslation && (
              <div className="flex shrink-0 gap-0 rounded-md border border-neutral-200 p-0.5">
                <button
                  type="button"
                  onClick={() => setOriginalQuote(null)}
                  className={
                    !showOriginal
                      ? "rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-900"
                      : "rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-700"
                  }
                >
                  译文
                </button>
                <button
                  type="button"
                  onClick={() => setOriginalQuote(quote)}
                  className={
                    showOriginal
                      ? "rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-900"
                      : "rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-700"
                  }
                >
                  原文
                </button>
              </div>
            )}
          </div>

          {/* Content — PR5: t.co only + 有 resolved_url 时走 XArticleCard
              3-tier (Rich cover+title+excerpt / Mid 仅 author / Basic 裸 URL) */}
          {isTcoOnly(quote.content) && quote.content_resolved_url ? (
            <XArticleCard
              article={quote.x_article}
              resolvedUrl={quote.content_resolved_url}
              content={quote.content}
            />
          ) : (
            displayText && (
              <div className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-[1.6] text-neutral-800">
                {displayText}
              </div>
            )
          )}

          {/* Media grid — 简化版,每张占满宽度 */}
          {images.length > 0 && (
            <div className="mt-3 grid gap-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={proxyImg(img.url, 800)}
                  alt={img.alt || ""}
                  loading="lazy"
                  className="w-full rounded-lg border border-neutral-200 object-cover"
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              ))}
            </div>
          )}

          {/* Metrics row */}
          {(m.replies != null || m.retweets != null || m.likes != null || m.views != null) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-neutral-500">
              {m.replies != null && <span>💬 {m.replies}</span>}
              {m.retweets != null && <span>↻ {m.retweets}</span>}
              {m.likes != null && <span>♡ {m.likes}</span>}
              {m.views != null && <span>👁 {m.views}</span>}
            </div>
          )}

          {/* External link */}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"
            >
              <IconShare className="h-3.5 w-3.5" />
              在 X 打开
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

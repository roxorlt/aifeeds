import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { QuoteOf } from "../types";
import { proxyImg, timeAgo } from "../lib/utils";
import { VerifiedBadge } from "./icons";

interface Props {
  quote: QuoteOf;
  /** B1: 嵌套小卡在 drawer 内（embedded=true）才允许点击跳 X；feed 流内点击
   *  应该让外层主卡 click 处理（先开抽屉），不直接跳出站。 */
  embedded?: boolean;
  /** PM 2026-05-20: 支持递归 1 次(retweet→quote→quote 或 quote→quote)。
   *  depth=0 默认主调用,depth=1 内嵌第二层,>=2 不再渲染避免无限套娃。
   *  内嵌层视觉降级:更小 padding + 不显 cover image + placeholder 兜底 */
  depth?: number;
}

const MAX_QUOTE_DEPTH = 2;

export function QuotedTweet({ quote, embedded, depth = 0 }: Props) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const handle = quote.handle || "";
  const author = quote.author || handle || "Unknown";
  const url =
    quote.id && handle ? `https://x.com/${handle}/status/${quote.id}` : "";
  const images = (quote.media || []).filter((m) => m.type === "image");
  const firstImage = images[0];
  const isNested = depth >= 1;
  // 内嵌第二层 quote — 直接拿对象(API inline)优先;只有 id 时画 placeholder
  const innerQuote = quote.quote_of;
  const innerQuoteId = quote.quote_of_id;
  const canRecurseInner = depth + 1 < MAX_QUOTE_DEPTH;

  // B1: drawer 内（embedded）才允许跳 X;feed 流内不阻止 propagation,
  // 让事件冒泡到外层 article 触发 openTweet。嵌套第二层时 stopPropagation
  // 防止误触外层
  const handleClick = embedded
    ? (e: ReactMouseEvent) => {
        e.stopPropagation();
        if (url) window.open(url, "_blank");
      }
    : isNested
      ? (e: ReactMouseEvent) => {
          // 嵌套层任何点击都阻止冒泡,避免外层 quote 误判
          e.stopPropagation();
          if (url) window.open(url, "_blank");
        }
      : undefined;

  return (
    <div
      className={
        isNested
          ? "mt-2 cursor-pointer overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50/40 transition-colors hover:bg-neutral-100"
          : embedded
            ? "mt-2.5 cursor-pointer overflow-hidden rounded-2xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50"
            : "mt-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-white"
      }
      onClick={handleClick}
    >
      <div className={isNested ? "p-2.5" : "p-3"}>
        {/* Compact header: avatar + name + verified + @handle · time */}
        <div className={isNested ? "flex items-center gap-1.5 text-[12px]" : "flex items-center gap-1.5 text-[13px]"}>
          {quote.profile_image_url && !avatarFailed ? (
            <img
              src={proxyImg(quote.profile_image_url, 80)}
              alt=""
              loading="lazy"
              className={isNested
                ? "h-4 w-4 shrink-0 rounded-full bg-neutral-200 object-cover"
                : "h-5 w-5 shrink-0 rounded-full bg-neutral-200 object-cover"}
              onError={() => setAvatarFailed(true)}
            />
          ) : null}
          <span className="truncate font-semibold text-neutral-900">
            {author}
          </span>
          {Boolean(quote.is_verified) && (
            <VerifiedBadge className="h-[14px] w-[14px] shrink-0 fill-sky-500" />
          )}
          {handle && (
            <span className="truncate text-neutral-500">@{handle}</span>
          )}
          {quote.published_at && (
            <>
              <span className="text-neutral-400">·</span>
              <span className="shrink-0 text-neutral-500">
                {timeAgo(quote.published_at)}
              </span>
            </>
          )}
        </div>

        {/* Body — translated if available, else original */}
        {(quote.content_translated || quote.content) && (
          <div className={isNested
            ? "mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-neutral-700"
            : "mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-neutral-800"}>
            {quote.content_translated || quote.content}
          </div>
        )}

        {/* 嵌套第二层 quote — 数据有就递归画;只有 id 没对象画 placeholder */}
        {canRecurseInner && innerQuote && (
          <QuotedTweet quote={innerQuote} embedded={embedded} depth={depth + 1} />
        )}
        {canRecurseInner && !innerQuote && innerQuoteId && (
          <div className="mt-2 rounded-md border border-dashed border-neutral-300 px-2 py-1.5 text-[12px] text-neutral-500">
            ❝ 引用了另一推(数据未补全)
          </div>
        )}
      </div>

      {/* Inline image — 嵌套层不显,避免视觉过重 */}
      {!isNested && firstImage && !imageFailed && (
        <img
          src={proxyImg(firstImage.url, 400)}
          alt={firstImage.alt || ""}
          loading="lazy"
          className="max-h-60 w-full border-t border-neutral-200 object-cover"
          onError={() => setImageFailed(true)}
        />
      )}
    </div>
  );
}

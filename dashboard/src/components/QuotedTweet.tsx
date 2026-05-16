import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { QuoteOf } from "../types";
import { proxyImg, timeAgo } from "../lib/utils";
import { VerifiedBadge } from "./icons";

interface Props {
  quote: QuoteOf;
  /** B1: 嵌套小卡在 drawer 内（embedded=true）才允许点击跳 X；feed 流内点击
   *  应该让外层主卡 click 处理（先开抽屉），不直接跳出站。 */
  embedded?: boolean;
}

export function QuotedTweet({ quote, embedded }: Props) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const handle = quote.handle || "";
  const author = quote.author || handle || "Unknown";
  const url =
    quote.id && handle ? `https://x.com/${handle}/status/${quote.id}` : "";
  const images = (quote.media || []).filter((m) => m.type === "image");
  const firstImage = images[0];

  // B1: drawer 内（embedded）才允许跳 X；feed 流内不阻止 propagation，
  // 让事件冒泡到外层 article 触发 openTweet。
  const handleClick = embedded
    ? (e: ReactMouseEvent) => {
        e.stopPropagation();
        if (url) window.open(url, "_blank");
      }
    : undefined;

  return (
    <div
      className={
        embedded
          ? "mt-2.5 cursor-pointer overflow-hidden rounded-2xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50"
          : "mt-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-white"
      }
      onClick={handleClick}
    >
      <div className="p-3">
        {/* Compact header: avatar + name + verified + @handle · time */}
        <div className="flex items-center gap-1.5 text-[13px]">
          {quote.profile_image_url && !avatarFailed ? (
            <img
              src={proxyImg(quote.profile_image_url, 80)}
              alt=""
              loading="lazy"
              className="h-5 w-5 shrink-0 rounded-full bg-neutral-200 object-cover"
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
          <div className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-neutral-800">
            {quote.content_translated || quote.content}
          </div>
        )}
      </div>

      {/* Inline image */}
      {firstImage && !imageFailed && (
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

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Item, ItemExtra, MediaItem, Metrics } from "../types";
import { cn, formatNumber, parseJsonField, proxyImg, timeAgo } from "../lib/utils";
import { useDrawer } from "../lib/drawer";
import { Lightbox } from "./Lightbox";
import { LinkCard } from "./LinkCard";
import { QuotedTweet } from "./QuotedTweet";
import {
  IconEye,
  IconHeart,
  IconReply,
  IconRetweet,
  VerifiedBadge,
} from "./icons";

// Match URL | #hashtag (CJK + ASCII) | @mention
const RICH_PATTERN =
  /(https?:\/\/[^\s<>"']+)|(#[\u4e00-\u9fa5\u3040-\u30ffA-Za-z0-9_]+)|(@[A-Za-z0-9_]{1,20})/g;

// pbs.twimg.com media URL looks like
//   https://pbs.twimg.com/media/<ID>?format=jpg&name=small
// or https://pbs.twimg.com/media/<ID>.jpg
// The <ID> is stable across size variants — use it for dedup.
function pbsMediaId(url: string): string {
  const m = url.match(/pbs\.twimg\.com\/media\/([^.?&/]+)/);
  return m ? m[1] : url;
}

function renderRichText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  RICH_PATTERN.lastIndex = 0;
  while ((m = RICH_PATTERN.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push(text.slice(lastIndex, m.index));
    }
    const [full, url, tag, mention] = m;
    if (url) {
      const display = url.length > 50 ? url.slice(0, 47) + "…" : url;
      out.push(
        <a
          key={key++}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-sky-600 hover:underline break-all"
        >
          {display}
        </a>,
      );
    } else if (tag) {
      out.push(
        <span key={key++} className="text-sky-600">
          {tag}
        </span>,
      );
    } else if (mention) {
      out.push(
        <a
          key={key++}
          href={`https://x.com/${mention.slice(1)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-sky-600 hover:underline"
        >
          {mention}
        </a>,
      );
    } else {
      out.push(full);
    }
    lastIndex = RICH_PATTERN.lastIndex;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

// Action (icon + count) with X-style hover halo
function MetricButton({
  icon,
  label,
  count,
  hoverColor,
}: {
  icon: ReactNode;
  label: string;
  count: number | null | undefined;
  hoverColor: "sky" | "green" | "pink" | "neutral";
}) {
  if (count === undefined || count === null) return null;
  const colorClasses: Record<typeof hoverColor, string> = {
    sky: "group-hover/metric:bg-sky-50 group-hover/metric:text-sky-500",
    green: "group-hover/metric:bg-emerald-50 group-hover/metric:text-emerald-500",
    pink: "group-hover/metric:bg-pink-50 group-hover/metric:text-pink-500",
    neutral: "group-hover/metric:bg-neutral-100 group-hover/metric:text-neutral-700",
  };
  const textColor: Record<typeof hoverColor, string> = {
    sky: "group-hover/metric:text-sky-500",
    green: "group-hover/metric:text-emerald-500",
    pink: "group-hover/metric:text-pink-500",
    neutral: "group-hover/metric:text-neutral-700",
  };
  return (
    <span
      aria-label={label}
      className="group/metric flex items-center gap-1 text-neutral-500 transition-colors"
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full transition-colors",
          colorClasses[hoverColor],
        )}
      >
        {icon}
      </span>
      <span className={cn("text-[12px] tabular-nums transition-colors", textColor[hoverColor])}>
        {formatNumber(count)}
      </span>
    </span>
  );
}

interface Props {
  item: Item;
  hideThreadBanner?: boolean;
  siblings?: Item[];
  embedded?: boolean;
  // Thread connector: render thin gray line through avatar column to visually
  // chain this tweet to sibling above/below.
  hasThreadAbove?: boolean;
  hasThreadBelow?: boolean;
  // When rendered inside a ThreadCard the outer container draws the bottom
  // border — suppress the per-card border regardless of hasThreadBelow so
  // the last reply doesn't create a divider between itself and the toggle.
  inThread?: boolean;
}

export function TweetCard({
  item,
  hideThreadBanner,
  siblings,
  embedded,
  hasThreadAbove,
  hasThreadBelow,
  inThread,
}: Props) {
  const { openTweet } = useDrawer();
  const [expanded, setExpanded] = useState(Boolean(embedded));
  const [showOriginal, setShowOriginal] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [canExpand, setCanExpand] = useState(false);

  const media = parseJsonField<MediaItem[]>(item.media) || [];
  const metrics = parseJsonField<Metrics>(item.metrics) || {};
  const extra = parseJsonField<ItemExtra>(item.extra) || {};

  const content = item.content || "";
  const translated = item.content_translated || "";
  const hasTranslation = Boolean(translated);
  const displayText = showOriginal
    ? content
    : hasTranslation
      ? translated
      : content;

  const canToggleOriginal = hasTranslation && content && translated !== content;

  // Only show the expand button when the clamped body actually overflows.
  // We can only measure this when clamped (expanded=false). Once measured as
  // overflowing, we keep the button visible across expand/collapse toggles.
  useLayoutEffect(() => {
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [displayText, expanded]);

  const handle = item.handle || "";
  const author = item.author || handle;
  const avatarUrl = extra.profile_image_url;
  const isVerified = Boolean(extra.is_verified);

  // Thread / reply / quote indicators
  const isThread = Boolean(extra.thread_root_id);
  const isReply = Boolean(extra.reply_to_id);
  const quoteOf = extra.quote_of;
  // Only show the "❝ 引用推文" banner if we have quote_of_id but no full quote_of data
  // (fallback for pre-backfill tweets). If we have quote_of, render nested card instead.
  const hasQuotePlaceholder = Boolean(extra.quote_of_id) && !quoteOf;

  const handleCardClick = (e: React.MouseEvent) => {
    if (embedded) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a")) return;
    openTweet(item, siblings || []);
  };

  // Exclude images that are already shown inside the quoted tweet card.
  // Scraper DOM picks up nested media under the outer article and the
  // syndication API returns its own size variants — URLs differ by query
  // params / size suffix but share the pbs.twimg.com media ID. Match by ID.
  const quotedImageIds = new Set(
    (quoteOf?.media || [])
      .filter((m) => m.type === "image")
      .map((m) => pbsMediaId(m.url)),
  );
  const images = media.filter(
    (m) => m.type === "image" && !quotedImageIds.has(pbsMediaId(m.url)),
  );
  const firstImage = images[0];
  const imageCount = images.length;
  const hasVideo = media.some((m) => m.type === "video");

  return (
    <article
      onClick={handleCardClick}
      className={cn(
        "group relative px-4 py-3 transition-colors",
        !hasThreadBelow && !inThread && "border-b border-neutral-200",
        !embedded && "cursor-pointer hover:bg-neutral-50/60",
      )}
    >
      {/* Thread connector lines (thin gray, centered on avatar column) */}
      {hasThreadAbove && (
        <div className="pointer-events-none absolute left-[35px] top-0 h-3 w-[2px] bg-neutral-200" />
      )}
      {hasThreadBelow && (
        <div className="pointer-events-none absolute left-[35px] top-[52px] bottom-0 w-[2px] bg-neutral-200" />
      )}
      {/* Thread / reply / quote banner */}
      {((isThread && !hideThreadBanner) || isReply || hasQuotePlaceholder) && (
        <div className="mb-1.5 ml-[52px] flex items-center gap-1.5 text-[12px] text-neutral-500">
          {isThread && !hideThreadBanner && (
            <span className="flex items-center gap-1">
              <span className="text-sky-500">🧵</span>
              <span>Thread</span>
            </span>
          )}
          {isReply && !isThread && (
            <span className="flex items-center gap-1">
              <span>↩</span>
              <span>回复</span>
            </span>
          )}
          {hasQuotePlaceholder && (
            <span className="flex items-center gap-1">
              <span>❝</span>
              <span>引用推文</span>
            </span>
          )}
        </div>
      )}

      {/* Avatar column + content column */}
      <div className="flex gap-3">
        {/* Avatar */}
        {avatarUrl && !avatarFailed ? (
          <img
            src={proxyImg(avatarUrl)}
            alt=""
            loading="lazy"
            className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[13px] font-semibold text-neutral-500">
            {(author || "?").charAt(0).toUpperCase()}
          </div>
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Header: author (row 1) + @handle · time (row 2) */}
          <div className="leading-tight">
            <div className="flex items-center gap-1 text-[15px]">
              <span className="truncate font-bold text-neutral-900">
                {author}
              </span>
              {isVerified && <VerifiedBadge />}
            </div>
            <div className="flex items-center gap-1 text-[13px] text-neutral-500">
              {handle && <span className="truncate">@{handle}</span>}
              {handle && <span className="text-neutral-400">·</span>}
              <span className="shrink-0">
                {timeAgo(item.published_at || item.scraped_at)}
              </span>
              {canToggleOriginal && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowOriginal((v) => !v);
                  }}
                  className="shrink-0 hover:text-neutral-900"
                >
                  {showOriginal ? "译文" : "原文"}
                </button>
              )}
            </div>
          </div>

          {/* Body */}
          <div
            ref={bodyRef}
            className={cn(
              "mt-1 text-[15px] leading-[1.45] text-neutral-900 break-words whitespace-pre-wrap",
              !expanded && "line-clamp-4",
            )}
          >
            {renderRichText(displayText)}
          </div>

          {/* "展开"/"收起" inline right after body (Twitter-style blue link) */}
          {canExpand && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className="mt-0.5 text-[14px] text-sky-600 hover:underline"
            >
              {expanded ? "收起" : "展开"}
            </button>
          )}

          {/* Quoted tweet (nested card) */}
          {quoteOf && <QuotedTweet quote={quoteOf} />}

          {/* Link preview card (URL auto-expanded by X) */}
          {extra.link_card && !quoteOf && <LinkCard card={extra.link_card} />}

          {/* Media */}
          {firstImage && !mediaFailed && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(0);
              }}
              className="relative mt-2.5 block w-full overflow-hidden rounded-2xl border border-neutral-200"
            >
              <img
                src={proxyImg(firstImage.url)}
                alt={firstImage.alt || ""}
                loading="lazy"
                className="aspect-[16/9] w-full object-cover transition-transform hover:scale-[1.02]"
                onError={() => setMediaFailed(true)}
              />
              {imageCount > 1 && (
                <span className="absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
                  +{imageCount - 1}
                </span>
              )}
              {hasVideo && (
                <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
                  ▶ 视频
                </span>
              )}
            </button>
          )}

          {/* Metrics bar (with 原文/译文 toggle pushed to the right) */}
          <div className="-ml-1.5 mt-1.5 flex items-center gap-5">
            <MetricButton
              icon={<IconReply className="h-[16px] w-[16px] fill-current" />}
              label="回复"
              count={metrics.replies}
              hoverColor="sky"
            />
            <MetricButton
              icon={<IconRetweet className="h-[16px] w-[16px] fill-current" />}
              label="转推"
              count={metrics.retweets}
              hoverColor="green"
            />
            <MetricButton
              icon={<IconHeart className="h-[16px] w-[16px] fill-current" />}
              label="喜欢"
              count={metrics.likes}
              hoverColor="pink"
            />
            <MetricButton
              icon={<IconEye className="h-[16px] w-[16px] fill-current" />}
              label="查看"
              count={metrics.views}
              hoverColor="neutral"
            />
          </div>
        </div>
      </div>

      {lightboxIndex !== null && images.length > 0 && (
        <Lightbox
          media={images}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </article>
  );
}

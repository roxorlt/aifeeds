import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { track, EVENTS } from "../lib/telemetry";
import { useImpression } from "../lib/telemetry/impressions";
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

// 决定是否 autoplay video。
// 浏览器现状（隐私收紧）：除 Chrome 外几乎都不暴露 navigator.connection；
// 即便暴露的，conn.type 也基本永远是 undefined，只有 effectiveType（"网速估计"
// 而非物理类型，wifi 和蜂窝都可能是 '4g'）。所以"严格 wifi-only autoplay"
// 在浏览器层做不到。务实做法：默认 autoplay（含 Safari/手机 wifi/Chrome），
// 只在两种明确"省流"信号下关掉：用户主动开 Data Saver（saveData=true）
// 或网络慢到 2g 级别（effectiveType in {'2g','slow-2g'}）。这样 mobile 4G
// 也会 autoplay — 是已知 trade-off，换 mobile wifi 体验对齐 PC。
function detectWifiAutoplay(): boolean {
  const conn = (navigator as unknown as { connection?: { type?: string; effectiveType?: string; saveData?: boolean } }).connection;
  if (!conn) return true; // Safari 等无 NetworkInformation：默认 autoplay
  if (conn.saveData) return false;
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return false;
  return true;
}

// 视频起播：HTML5 `autoPlay` 属性在 mobile WebView/微信里时序经常不稳，src
// 还没 ready 就触发 → silently fail。改用 ref + useEffect 显式调 video.play()，
// 拿 promise rejection 反馈 + 埋点上报，定位为什么不 autoplay。
function VideoPlayer({
  src,
  poster,
  autoplay,
  itemId,
  sourceType,
  onError,
}: {
  src: string;
  poster?: string;
  autoplay: boolean;
  itemId: string;
  sourceType: string;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playStartedRef = useRef(false);

  useEffect(() => {
    if (!autoplay) return;
    const video = videoRef.current;
    if (!video) return;
    const conn = (navigator as unknown as { connection?: { type?: string; effectiveType?: string; saveData?: boolean } }).connection;
    const networkInfo = {
      effective_type: conn?.effectiveType ?? "unknown",
      save_data: conn?.saveData ?? false,
      conn_type: conn?.type ?? "unknown",
    };
    track(EVENTS.VIDEO_AUTOPLAY_ATTEMPT, {
      item_id: itemId,
      source: sourceType,
      ...networkInfo,
    });
    video.play().catch((err: Error) => {
      track(EVENTS.VIDEO_AUTOPLAY_BLOCKED, {
        item_id: itemId,
        source: sourceType,
        error_name: err.name,
        error_message: (err.message || "").slice(0, 120),
        ...networkInfo,
      });
    });
  }, [autoplay, itemId, sourceType]);

  const handlePlay = () => {
    if (playStartedRef.current) return;
    playStartedRef.current = true;
    track(EVENTS.VIDEO_PLAY_START, {
      item_id: itemId,
      source: sourceType,
      triggered: autoplay ? "auto" : "user",
    });
  };

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      preload="metadata"
      controls
      muted={autoplay}
      loop={autoplay}
      playsInline
      className="aspect-[16/9] w-full bg-black object-cover"
      onPlay={handlePlay}
      onError={onError}
    />
  );
}

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

// X-platform metric (read-only metadata, not an action button).
// Flat icon + number — no halo / rounded container / hover so it doesn't
// look interactive.
function Metric({
  icon,
  label,
  count,
}: {
  icon: ReactNode;
  label: string;
  count: number | null | undefined;
}) {
  const isMissing = count === undefined || count === null;
  const display = isMissing ? "—" : formatNumber(count);
  return (
    <span
      aria-label={label}
      className={cn(
        "flex items-center gap-1",
        isMissing ? "text-neutral-300" : "text-neutral-500",
      )}
    >
      {icon}
      <span className="text-[12px] tabular-nums">{display}</span>
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
  const impressionRef = useImpression(() => {
    if (embedded) return; // drawer 内嵌套的卡片不算曝光
    track(EVENTS.ITEM_IMPRESSION, {
      item_id: item.id,
      source: item.source_type,
    });
  });
  const [expanded, setExpanded] = useState(Boolean(embedded));
  const [showOriginal, setShowOriginal] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [autoplayVideo, setAutoplayVideo] = useState<boolean>(() => detectWifiAutoplay());
  useEffect(() => {
    const conn = (navigator as unknown as { connection?: EventTarget }).connection;
    if (!conn) return;
    const handler = () => setAutoplayVideo(detectWifiAutoplay());
    conn.addEventListener('change', handler);
    return () => conn.removeEventListener('change', handler);
  }, []);
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
  const replyOf = extra.reply_of;
  const isReply = Boolean(extra.reply_to_id) || Boolean(extra.reply_of_id);
  const quoteOf = extra.quote_of;
  // Only show the "❝ 引用推文" banner if we have quote_of_id but no full quote_of data
  // (fallback for pre-backfill tweets). If we have quote_of, render nested card instead.
  const hasQuotePlaceholder = Boolean(extra.quote_of_id) && !quoteOf;
  // Reply placeholder when we know it's a reply but parent fetch hasn't run yet.
  const hasReplyPlaceholder = isReply && !replyOf;

  const downPos = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    downPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if (embedded) return;
    const start = downPos.current;
    if (start) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 5 || dy > 5) return; // drag → not a click
    }
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return; // text selected
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a")) return;
    track(EVENTS.ITEM_CLICK, {
      item_id: item.id,
      source: item.source_type,
    });
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
  // 同时保留 image 和 video，按 DOM 顺序拼成 lightbox 数据。卡片本身只
  // 画第一个 media（image / video 都能当封面）；video 走 <video poster
  // muted preload=metadata>，浏览器自动抓首帧当 poster；卡片不自动播放，
  // 点击进 Lightbox 才用 controls + autoPlay。
  const lightboxMedia = media.filter(
    (m) =>
      (m.type === "image" || m.type === "video") &&
      !(m.type === "image" && quotedImageIds.has(pbsMediaId(m.url))),
  );
  const firstMedia = lightboxMedia[0];
  const mediaCount = lightboxMedia.length;
  const hasVideo = lightboxMedia.some((m) => m.type === "video");

  return (
    <article
      ref={impressionRef}
      onPointerDown={handlePointerDown}
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
      {/* Thread / quote-placeholder banner (kept outside avatar block — rare cases).
          Reply banner moves into the content column, below the header (see further down). */}
      {((isThread && !hideThreadBanner) || hasQuotePlaceholder) && (
        <div className="mb-1.5 ml-[52px] flex items-center gap-1.5 text-[12px] text-neutral-500">
          {isThread && !hideThreadBanner && (
            <span className="flex items-center gap-1">
              <span className="text-sky-500">🧵</span>
              <span>Thread</span>
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
          {/* Header: single row — author + ✓ + @handle · time + 原文 toggle */}
          <div className="flex items-baseline gap-1 text-[13px] text-neutral-500">
            <span className="truncate text-[15px] font-bold leading-tight text-neutral-900">
              {author}
            </span>
            {isVerified && (
              <span className="shrink-0 self-center">
                <VerifiedBadge />
              </span>
            )}
            {handle && <span className="truncate">@{handle}</span>}
            <span className="shrink-0 text-neutral-400">·</span>
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

          {/* Reply banner (a): under header, above body */}
          {(replyOf || hasReplyPlaceholder) && !isThread && (
            <div className="mt-0.5 flex items-center gap-1 text-[12px] text-neutral-500">
              <span>↩</span>
              <span>
                {replyOf
                  ? `回复 @${replyOf.handle || "?"}`
                  : "回复"}
              </span>
            </div>
          )}

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

          {/* 顺序（PR6 反馈 #4.3）：A 自身 body → A 自身 media → 引用块 (B/D)。
              当 A 回复 B 或 C 引用 D 且 A/C 自带图片时，图片应贴在 A/C 正文下方，
              而不是钻到 B/D 引用块下面。无 reply/quote 时这个顺序也不影响普通推文。 */}

          {/* Media —
              视频：流内 inline 播放，HTML5 controls（含原生全屏按钮）。wifi
              autoplay/muted/loop，非 wifi 不 autoplay 让用户主动点。卡片其它
              位置点击仍可开 drawer，video 自身 onClick 阻止冒泡避免误触。
              图片：保留点击进 Lightbox 大图查看的旧行为。 */}
          {firstMedia && !mediaFailed && firstMedia.type === "video" && (
            <div
              className="relative mt-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-black"
              onClick={(e) => e.stopPropagation()}
            >
              <VideoPlayer
                src={proxyImg(firstMedia.url)}
                poster={firstMedia.poster ? proxyImg(firstMedia.poster) : undefined}
                autoplay={autoplayVideo}
                itemId={item.id}
                sourceType={item.source_type}
                onError={() => setMediaFailed(true)}
              />
              {mediaCount > 1 && (
                <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
                  +{mediaCount - 1}
                </span>
              )}
            </div>
          )}
          {firstMedia && !mediaFailed && firstMedia.type === "image" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(0);
              }}
              className="relative mt-2.5 block w-full overflow-hidden rounded-2xl border border-neutral-200"
            >
              <img
                src={proxyImg(firstMedia.url)}
                alt={firstMedia.alt || ""}
                loading="lazy"
                className="aspect-[16/9] w-full object-cover transition-transform hover:scale-[1.02]"
                onError={() => setMediaFailed(true)}
              />
              {mediaCount > 1 && (
                <span className="absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
                  +{mediaCount - 1}
                </span>
              )}
              {/* 顶部角标只在 first 是图但里面有 video 时显示（提醒"还有视频"） */}
              {hasVideo && (
                <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
                  ▶ 视频
                </span>
              )}
            </button>
          )}

          {/* Reply parent (d) — show below A 自身 media，作为上下文脚注 */}
          {replyOf && <QuotedTweet quote={replyOf} />}

          {/* Quoted tweet (nested card) */}
          {quoteOf && <QuotedTweet quote={quoteOf} />}

          {/* Link preview card (URL auto-expanded by X) */}
          {extra.link_card && !quoteOf && <LinkCard card={extra.link_card} />}

          {/* Metrics bar (read-only X-platform data, not interactive) */}
          <div className="mt-2 flex items-center gap-4">
            <Metric
              icon={<IconReply className="h-[14px] w-[14px] fill-current" />}
              label="回复"
              count={metrics.replies}
            />
            <Metric
              icon={<IconRetweet className="h-[14px] w-[14px] fill-current" />}
              label="转推"
              count={metrics.retweets}
            />
            <Metric
              icon={<IconHeart className="h-[14px] w-[14px] fill-current" />}
              label="喜欢"
              count={metrics.likes}
            />
            <Metric
              icon={<IconEye className="h-[14px] w-[14px] fill-current" />}
              label="查看"
              count={metrics.views}
            />
          </div>
        </div>
      </div>

      {lightboxIndex !== null && lightboxMedia.length > 0 && (
        <Lightbox
          media={lightboxMedia}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </article>
  );
}

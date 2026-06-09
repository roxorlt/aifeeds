import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { track, EVENTS } from "../lib/telemetry";
import { useImpression } from "../lib/telemetry/impressions";
import { useImpressionRefresh, mergeRefs } from "../lib/impressionRefresh";
import type { Item, ItemExtra, LinkCard as LinkCardType, MediaItem, Metrics, QuoteOf } from "../types";
import { cn, formatBjtMdHm, formatNumber, parseJsonField, proxyImg, timeAgo } from "../lib/utils";
import { smartTruncate } from "../lib/truncate";
import { useCoordinatedVideo } from "../lib/useCoordinatedVideo";
import { useDrawer } from "../lib/drawer";
import { translateNowItem, TranslateNowError } from "../api";
import { dispatchItemUpdate } from "../lib/itemUpdateBus";
import { toast } from "../lib/toast";
import { useAuthStore } from "../lib/authStore";
import { Lightbox } from "./Lightbox";
import { LinkCard } from "./LinkCard";
import { QuotedTweet } from "./QuotedTweet";
import { isTcoOnly } from "./TcoResolvedLinkCard";
import { isSelfLinkCard } from "../lib/linkCardFilter";
import { XArticleCard } from "./XArticleCard";
import {
  IconEye,
  IconHeart,
  IconReply,
  IconRetweet,
  IconThread,
  VerifiedBadge,
} from "./icons";

// Match URL | #hashtag (CJK + ASCII) | @mention
const RICH_PATTERN =
  /(https?:\/\/[^\s<>"']+)|(#[\u4e00-\u9fa5\u3040-\u30ffA-Za-z0-9_]+)|(@[A-Za-z0-9_]{1,20})/g;

// 视频播放：接 VideoCoordinator（dashboard/src/lib/videoCoordinator.ts）
// 全局只 1 个视频在播；可见性 / 优先级 / mute 全由 hook 自动处理。
// 设计文档：docs/plans/2026-05-15-video-playback-coordinator-design.md
function VideoPlayer({
  src,
  poster,
  itemId,
  sourceType,
  onError,
}: {
  src: string;
  poster?: string;
  itemId: string;
  sourceType: string;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playStartedRef = useRef(false);
  // video_effective_play 节流：连续播放 ≥3s 才上报一次（IAB / Twitter / Meta 短视频
  // view 行业标准）。pause / ended 取消未触发 timer，unmount 必须清防 phantom track。
  const effectiveTimerRef = useRef<number | null>(null);
  const effectiveReportedRef = useRef(false);
  const [showControls, setShowControls] = useState(false);

  const { isActive, muted } = useCoordinatedVideo({
    videoId: `${sourceType}:${itemId}`,
    videoRef,
  });

  const clearEffectiveTimer = () => {
    if (effectiveTimerRef.current !== null) {
      window.clearTimeout(effectiveTimerRef.current);
      effectiveTimerRef.current = null;
    }
  };

  const handlePlay = () => {
    if (!playStartedRef.current) {
      playStartedRef.current = true;
      track(EVENTS.VIDEO_PLAY_START, {
        item_id: itemId,
        source: sourceType,
        triggered: isActive ? "auto" : "user",
      });
    }
    if (!effectiveReportedRef.current && effectiveTimerRef.current === null) {
      effectiveTimerRef.current = window.setTimeout(() => {
        effectiveReportedRef.current = true;
        track(EVENTS.VIDEO_EFFECTIVE_PLAY, {
          item_id: itemId,
          source: sourceType,
          threshold_ms: 3000,
          triggered: isActive ? "auto" : "user",
        });
        effectiveTimerRef.current = null;
      }, 3000);
    }
  };

  useEffect(() => clearEffectiveTimer, []);

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      preload="metadata"
      controls={showControls}
      muted={muted}
      loop
      playsInline
      className="aspect-[16/9] w-full bg-black object-cover"
      // PC hover 显示播控浮层；mobile / touch 上 hover 不触发，仍靠 click toggle
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      onClick={() => setShowControls(true)}
      onPlay={handlePlay}
      onPause={clearEffectiveTimer}
      onEnded={clearEffectiveTimer}
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
        "flex shrink-0 items-center gap-1 whitespace-nowrap",
        isMissing ? "text-neutral-300" : "text-neutral-500",
      )}
    >
      {icon}
      <span className="text-[12px] tabular-nums whitespace-nowrap">{display}</span>
    </span>
  );
}

// MetricsRow: X 推文 4 字段（回复/转推/喜欢/查看）。
// 主推 + 父推 row + thread sibling 共用。
function MetricsRow({ metrics }: { metrics: Metrics }) {
  return (
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
  );
}

// TweetMediaTile: 单图 / 单视频 + 多 media 时角标 (+N) 提示。
// 视频 inline 播放（VideoCoordinator 协调），图片点击触发 onClickImage(idx)。
// videoIdSuffix 用来在同一 article 内区分主推 / 父推 / sibling 的 video coordinator id。
function TweetMediaTile({
  media,
  itemId,
  sourceType,
  videoIdSuffix = "",
  onClickImage,
  posterMode,
}: {
  media: MediaItem[];
  itemId: string;
  sourceType: string;
  videoIdSuffix?: string;
  onClickImage: (idx: number) => void;
  posterMode?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed || media.length === 0) return null;
  const first = media[0];
  const mediaCount = media.length;
  const hasVideo = media.some((m) => m.type === "video");

  // 海报模式:modern-screenshot 截图遇到真实 <video> 会卡在等 loadeddata
  // (preload=metadata 永不 fire) + 跨域 seek,体感"一直转圈"。这里改渲染封面
  // <img> + ▶ 视频 角标(等价 PhCard 的视频封面处理),截图不再 hang。
  // 封面优先用视频自带 poster 帧,缺失则退到媒体里的下一张图片(对应用户反馈
  // "第一个附件取不到图就取第二个位置"),再缺失留灰底占位(不放 <img> 即不会卡)。
  if (posterMode && first.type === "video") {
    const firstImage = media.find((m) => m.type === "image" && m.url);
    const coverUrl = first.poster
      ? proxyImg(first.poster, 400)
      : firstImage
        ? proxyImg(firstImage.url, 400)
        : "";
    return (
      <div className="relative mt-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-black">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={first.alt || ""}
            className="aspect-[16/9] w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="aspect-[16/9] w-full" />
        )}
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
          ▶ 视频
        </span>
        {mediaCount > 1 && (
          <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
            +{mediaCount - 1}
          </span>
        )}
      </div>
    );
  }

  if (first.type === "video") {
    return (
      <div
        className="relative mt-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-black"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <VideoPlayer
          src={proxyImg(first.url)}
          poster={first.poster ? proxyImg(first.poster, 400) : undefined}
          itemId={`${itemId}${videoIdSuffix}`}
          sourceType={sourceType}
          onError={() => setFailed(true)}
        />
        {mediaCount > 1 && (
          <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
            +{mediaCount - 1}
          </span>
        )}
      </div>
    );
  }

  if (first.type === "image") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClickImage(0);
        }}
        className="relative mt-2.5 block w-full overflow-hidden rounded-2xl border border-neutral-200"
      >
        {/* PM 2026-05-22: 之前 aspect-[16/9] + object-cover 高图被裁切.
            改成宽度撑满 + 高度按图原比例自适应 (height: auto), 不裁不变形 */}
        <img
          src={proxyImg(first.url, 400)}
          alt={first.alt || ""}
          loading="lazy"
          className="w-full transition-transform hover:scale-[1.02]"
          onError={() => setFailed(true)}
        />
        {mediaCount > 1 && (
          <span className="absolute right-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
            +{mediaCount - 1}
          </span>
        )}
        {hasVideo && (
          <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
            ▶ 视频
          </span>
        )}
      </button>
    );
  }

  return null;
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
  // PR2 v3 (2026-05-25):海报渲染模式 — PosterCanvas 复用 TweetCard 时,
  // header 隐藏 @handle 跟"原文"按钮、时间用 MM-DD HH:MM 固定格式(而非
  // 易过期的"3 天前")、verified badge 跟昵称留更大 gap (海报字号放大场景)
  posterMode?: boolean;
}

export function TweetCard({
  item,
  hideThreadBanner,
  siblings,
  embedded,
  hasThreadAbove,
  hasThreadBelow,
  inThread,
  posterMode,
}: Props) {
  const { openTweet } = useDrawer();
  const impressionRef = useImpression(() => {
    if (embedded) return; // drawer 内嵌套的卡片不算曝光
    track(EVENTS.ITEM_IMPRESSION, {
      item_id: item.id,
      source: item.source_type,
    });
  });
  // BE §5b: 视口停留 500ms 弱触发 metrics refresh (worker 5min KV throttle 兜底).
  // drawer 内嵌套的卡片不触发 (跟 impression 一样的语义,只算主 feed 上的浏览)
  const refreshRef = useImpressionRefresh(embedded ? null : item.id);
  const [expanded, setExpanded] = useState(Boolean(embedded));
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [replyLightboxIndex, setReplyLightboxIndex] = useState<number | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [canExpand, setCanExpand] = useState(false);

  const media = parseJsonField<MediaItem[]>(item.media) || [];
  const metrics = parseJsonField<Metrics>(item.metrics) || {};
  const extra = parseJsonField<ItemExtra>(item.extra) || {};

  // F1: 转推处理。is_retweet=1 时 X 平台显示的是「被转推者」的卡片 + 顶部
  //   "♻ {转推者} 已转帖" 小字。aifeeds 沿用：
  //   - 如果 retweet_of 完整数据存在 → 翻转作者主体，content 用 retweet_of.content
  //   - 如果 retweet_of 缺（backfill 未跑到）→ 兜底用转推者卡 + 剥 "RT @xxx: " 前缀
  const isRetweet = Boolean(extra.is_retweet);
  // 转推者本人信息（顶部「已转帖」小字用，跟主卡翻转身份严格分开，绝不混用）
  const retweeterHandle = item.handle || "";
  const retweeterAuthor = item.author || retweeterHandle;
  // X 渲染契约 §1：转推主卡永远是「原作者」，绝不 fallback 成转推者（那正是反复出现的冒名 bug）。
  // 原推快照取值优先级：
  //   1. retweet_of（正常回填）
  //   2. quote_of —— 仅当它其实就是转推目标(quote_of_id == retweeted_status_id)。纯转推被
  //      nested-x-quote 误标成 quote 的存量数据走这条借用，保证拿回原作者而不是丢失。
  const retweetedStatusId = extra.retweeted_status_id || null;
  const retweetOf: QuoteOf | null =
    extra.retweet_of ||
    (isRetweet && extra.quote_of && extra.quote_of_id && extra.quote_of_id === retweetedStatusId
      ? extra.quote_of
      : null) ||
    null;
  // 降级（转推但无任何原推快照）：从 "RT @handle:" 前缀或 user_mentions[0] 取原作者 handle
  //   当主卡身份（只有 handle、无头像/蓝标），仍然不显示转推者。Layer-4 回填后这些行补上完整
  //   retweet_of，此分支只兜「回填窗口期 + 原推被删」的少数情况。
  const rtFallbackHandle =
    isRetweet && !retweetOf
      ? (item.content || "").match(/^RT @(\w+):/)?.[1] || extra.user_mentions?.[0] || null
      : null;
  // 主卡作者/handle：翻转到原作者快照 → 降级到原作者 handle → null（由下方消费处兜底为通用占位）
  const flippedAuthor = retweetOf ? (retweetOf.author || retweetOf.handle || null) : rtFallbackHandle;
  const flippedHandle = retweetOf ? (retweetOf.handle || "") : rtFallbackHandle;
  const flippedAvatar = retweetOf ? retweetOf.profile_image_url : null;
  const flippedVerified = retweetOf ? Boolean(retweetOf.is_verified) : null;
  // 时间戳：翻转时显示被转推时间（X 一致），降级/兜底时显示转推时间
  const flippedPublishedAt = retweetOf ? retweetOf.published_at : null;

  // content 处理：翻转时优先用 retweet_of.content + content_translated（item 的
  // 翻译是基于完整 "RT @xxx: ..." 文本翻译的，可能含 RT 前缀的翻译版，要剥）
  const stripRtPrefix = (s: string): string => s.replace(/^RT @\w+:\s*/, "");
  let content = item.content || "";
  let translated = item.content_translated || "";
  if (isRetweet) {
    if (retweetOf?.content) {
      content = retweetOf.content;
    } else {
      content = stripRtPrefix(content);
    }
    translated = stripRtPrefix(translated);
  }
  const hasTranslation = Boolean(translated);
  const displayText = showOriginal
    ? content
    : hasTranslation
      ? translated
      : content;

  const canToggleOriginal = hasTranslation && content && translated !== content;

  // 译文按钮即时翻译：x_list 源 + 主推未翻译时显示「译文」按钮，点击触发
  // POST /api/items/:id/translate-now（cookie auth），BE 一次性翻完所有 NULL 的 _zh 字段。
  // 非 x_list 源不显示按钮（防止误调，BE 400 unsupported_source 兜底）。
  const isXList = item.source_type === "x_list";
  const needsTranslation = isXList && !item.content_translated;
  const showLangButton = canToggleOriginal || needsTranslation;

  const handleLangButtonClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canToggleOriginal) {
      setShowOriginal((v) => !v);
      return;
    }
    if (!needsTranslation || translating) return;
    setTranslating(true);
    try {
      const result = await translateNowItem(item.id);
      const prevExtra = parseJsonField<ItemExtra>(item.extra) || {};
      const nextExtra: ItemExtra = { ...prevExtra };
      if (prevExtra.reply_of && result.reply_of_zh) {
        nextExtra.reply_of = { ...prevExtra.reply_of, content_translated: result.reply_of_zh } as QuoteOf;
      }
      if (prevExtra.quote_of && result.quote_of_zh) {
        nextExtra.quote_of = { ...prevExtra.quote_of, content_translated: result.quote_of_zh } as QuoteOf;
      }
      if (prevExtra.retweet_of && result.retweet_of_zh) {
        nextExtra.retweet_of = { ...prevExtra.retweet_of, content_translated: result.retweet_of_zh } as QuoteOf;
      }
      if (prevExtra.link_card && (result.link_card_title_zh || result.link_card_desc_zh)) {
        nextExtra.link_card = {
          ...prevExtra.link_card,
          title_translated: result.link_card_title_zh ?? prevExtra.link_card.title_translated,
          description_translated: result.link_card_desc_zh ?? prevExtra.link_card.description_translated,
        } as LinkCardType;
      }
      const updatedItem: Item = {
        ...item,
        content_translated: result.content_zh ?? item.content_translated,
        extra: nextExtra,
      };
      dispatchItemUpdate(updatedItem);
      toast.success("翻译完成");
    } catch (err) {
      if (err instanceof TranslateNowError) {
        switch (err.code) {
          case "unauthorized":
            toast.error("登录态已过期，请重新登录");
            useAuthStore.getState().openLoginModal("api_401");
            break;
          case "not_found":
            // 静默回退（item 已不存在）
            break;
          case "unsupported_source":
            toast.error(`${err.details.source_type || "该源"}不支持翻译`);
            break;
          case "rate_limited":
            toast.info(`翻译冷却中，${err.details.retry_after_sec ?? 60}s 后可重试`);
            break;
          case "daily_cap_exceeded":
            toast.error(
              `今日翻译额度已用完（${err.details.used ?? 20}/${err.details.cap ?? 20}），请明日再试`,
            );
            break;
          case "translation_failed":
            toast.error("翻译失败，请稍后重试");
            break;
          default:
            toast.error("翻译失败");
        }
      } else {
        toast.error("翻译失败");
      }
    } finally {
      setTranslating(false);
    }
  };

  // 接入 smartTruncate 后，"是否需要展开"取决于原文是否被 truncate 截短了。
  // truncated 比原文短 → 一定有截断 → 显示展开按钮。
  // 兜底：truncated 没短但 line-clamp-4 仍触发（极短文本 + 多行 emoji 等），
  // 用 scrollHeight > clientHeight 双保险。
  const truncatedDisplayLen = smartTruncate(displayText, 280).length;
  useLayoutEffect(() => {
    if (truncatedDisplayLen < displayText.length) {
      setCanExpand(true);
      return;
    }
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [displayText, expanded, truncatedDisplayLen]);

  // 主卡身份（X 渲染契约 §1）：非转推用 item 本身；转推只用翻转/降级出的原作者身份，
  // 绝不回退到转推者 item.author/item.handle（杜绝「A 转帖 A 自己」的冒名）。
  const handle = isRetweet ? (flippedHandle ?? "") : (item.handle ?? "");
  const author = isRetweet
    ? (flippedAuthor ?? flippedHandle ?? "原推作者")
    : (item.author ?? item.handle ?? "");
  const avatarUrl = isRetweet ? (flippedAvatar ?? undefined) : extra.profile_image_url;
  const isVerified = isRetweet ? Boolean(flippedVerified) : Boolean(extra.is_verified);
  // 时间戳：翻转时用被转推时间，否则原 published_at/scraped_at
  const displayTime = (isRetweet ? flippedPublishedAt : item.published_at) ?? item.published_at ?? item.scraped_at;

  // Thread / reply / quote indicators
  const isThread = Boolean(extra.thread_root_id);
  const replyOf = extra.reply_of;
  const isReply = Boolean(extra.reply_to_id) || Boolean(extra.reply_of_id);
  // PM 2026-05-20:retweet 场景下,主卡显示已翻转到 retweet_of(被转推者),
  // 嵌套 quote 也应该取 retweet_of.quote_of(被转推者引用的那一推),
  // 而不是 top-level extra.quote_of(retweet 时 top-level 通常空)
  // 例:tweet 2056769896458166631 = levie RT fchollet,fchollet 又 quote 了第三方,
  // 流内卡片之前完全丢这第二层
  // X 渲染契约 §2/§3：嵌套引用卡只画「真正的引用」。
  //   - 转推：只画原推自己的二级引用 retweetOf.quote_of；转推目标(quote_of_id==retweeted_status_id)
  //     已被 retweetOf 借走当主卡，绝不再当引用画（否则同一推文显示两遍 = 幽灵重复卡）。
  //   - 非转推：画 extra.quote_of，但排除 quote_of_id==retweeted_status_id 的幽灵引用。
  const isPhantomQuote = Boolean(extra.quote_of_id) && extra.quote_of_id === retweetedStatusId;
  const quoteOf = isRetweet
    ? (retweetOf?.quote_of ?? null)
    : (isPhantomQuote ? null : (extra.quote_of ?? null));
  const quoteOfId = isRetweet
    ? (retweetOf?.quote_of_id ?? null)
    : (isPhantomQuote ? null : (extra.quote_of_id ?? null));
  // 有 quote_of_id 但拉不到完整 quote_of → X 风格「不可用」灰框（仅真正引用，幽灵引用已排除）。
  const hasQuotePlaceholder = Boolean(quoteOfId) && !quoteOf;
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
  const replyLightboxMedia = (replyOf?.media || []).filter(
    (m) => m.type === "image" || m.type === "video",
  );

  return (
    <article
      ref={mergeRefs(impressionRef, refreshRef)}
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
      {/* 删除 F2 quote 头像下方 connector stub：之前加这个是误判 X 流内样式
          （X 流内 quote 没有 connector，靠嵌套小卡边框本身表达"引用"语义）。
          删后行为对齐 X：thread/reply 有 connector，quote/retweet 无。 */}

{/* F3: Reply 父推渲染（thread 视觉语言）。X 详情页 reply 链是父推→
          connector line→当前推连续显示，aifeeds 之前用 quote 嵌套小卡视觉
          不一致。父推渲染成独立 row + avatar 同列 connector line 连主推。
          抽屉（embedded=true）+ 流内（embedded=false）都展示。仅 isThread
          已经有 thread connector 时跳过，不重复画。 */}
      {!isThread && replyOf && (
        <div className="relative mb-3">
          <div className="pointer-events-none absolute left-[35px] top-[52px] bottom-[-12px] w-[2px] bg-neutral-200" />
          <div className="flex gap-3">
            {replyOf.profile_image_url ? (
              <img
                src={proxyImg(replyOf.profile_image_url, 80)}
                alt=""
                loading="lazy"
                className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[13px] font-semibold text-neutral-500">
                {(replyOf.author || replyOf.handle || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              {/* PM 2026-05-25 R7 双行 header:author + ✓ / @handle · 时间 */}
              <div>
                <div className="flex items-baseline gap-1">
                  <span
                    className={cn(
                      "text-[15px] font-bold leading-tight text-neutral-900",
                      posterMode ? "shrink-0 whitespace-nowrap" : "truncate",
                    )}
                  >
                    {replyOf.author || replyOf.handle}
                  </span>
                  {Boolean(replyOf.is_verified) && (
                    <span className="shrink-0 self-center">
                      <VerifiedBadge />
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-baseline gap-1 text-[13px] text-neutral-500">
                  {replyOf.handle && <span className="truncate">@{replyOf.handle}</span>}
                  {replyOf.handle && replyOf.published_at && <span className="shrink-0 text-neutral-400">·</span>}
                  {replyOf.published_at && (
                    <span className="shrink-0 whitespace-nowrap">
                      {posterMode ? formatBjtMdHm(replyOf.published_at) : timeAgo(replyOf.published_at)}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-1 line-clamp-4 break-words whitespace-pre-wrap text-[15px] leading-[1.45] text-neutral-800">
                {replyOf.content_translated || replyOf.content || ""}
              </div>
              <TweetMediaTile
                media={replyLightboxMedia}
                itemId={replyOf.id || `${item.id}-replyOf`}
                sourceType={item.source_type}
                videoIdSuffix="-replyOf"
                onClickImage={(idx) => setReplyLightboxIndex(idx)}
                posterMode={posterMode}
              />
              {replyOf.metrics && <MetricsRow metrics={replyOf.metrics} />}
            </div>
          </div>
        </div>
      )}
      {/* Thread / quote-placeholder banner (kept outside avatar block — rare cases).
          Reply banner moves into the content column, below the header (see further down). */}
      {((isThread && !hideThreadBanner) || isRetweet) && (
        <div className="mb-1.5 ml-[52px] flex flex-wrap items-center gap-1.5 text-[12px] text-neutral-500">
          {isThread && !hideThreadBanner && (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
              <IconThread className="h-3.5 w-3.5 fill-current text-sky-500" />
              <span className="whitespace-nowrap">Thread</span>
            </span>
          )}
          {isRetweet && (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
              <IconRetweet className="h-3.5 w-3.5 fill-current text-sky-500" />
              <span className="whitespace-nowrap">{retweeterAuthor || `@${retweeterHandle}`} 已转帖</span>
            </span>
          )}
        </div>
      )}

      {/* Avatar column + content column */}
      <div className="flex gap-3">
        {/* Avatar */}
        {avatarUrl && !avatarFailed ? (
          <img
            src={proxyImg(avatarUrl, 80)}
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
          {/* Header — PM 2026-05-25 R7 双行布局:
              第 1 行:author + verified badge
              第 2 行:@handle · 时间 (· 原文按钮, posterMode 不显)
              单行容器旧布局在 author 长 / 字号大场景容易挤,双行后更耐挤. */}
          <div>
            {/* Row 1: author + ✓ */}
            <div className="flex items-baseline gap-1">
              <span
                className={cn(
                  "text-[15px] font-bold leading-tight text-neutral-900",
                  posterMode ? "shrink-0 whitespace-nowrap" : "truncate",
                )}
              >
                {author}
              </span>
              {isVerified && (
                <span className="shrink-0 self-center">
                  <VerifiedBadge />
                </span>
              )}
            </div>
            {/* Row 2: @handle · 时间 · 原文按钮 */}
            <div className="mt-0.5 flex items-baseline gap-1 text-[13px] text-neutral-500">
              {handle && <span className="truncate">@{handle}</span>}
              {handle && <span className="shrink-0 text-neutral-400">·</span>}
              <span className="shrink-0 whitespace-nowrap">
                {posterMode ? formatBjtMdHm(displayTime) : timeAgo(displayTime)}
              </span>
              {!posterMode && showLangButton && (
                <>
                  <span className="shrink-0 text-neutral-400">·</span>
                  <button
                    type="button"
                    disabled={translating}
                    onClick={handleLangButtonClick}
                    className="shrink-0 hover:text-neutral-900 disabled:cursor-default disabled:text-neutral-300"
                  >
                    {translating
                      ? "翻译中…"
                      : canToggleOriginal
                        ? showOriginal
                          ? "译文"
                          : "原文"
                        : "译文"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* F3: Reply 占位提示（仅 replyOf 数据未回填时显示，X 详情页里完整 reply
              用 thread 视觉语言把父推渲染在主推上方；只有兜底的 placeholder 才保留小字）*/}
          {hasReplyPlaceholder && !isThread && (
            <div className="mt-0.5 flex items-center gap-1 text-[12px] text-neutral-500">
              <span>↩</span>
              <span>回复</span>
            </div>
          )}

          {/* Body — PR5: 主推 content 是单纯 t.co 短链时,走 XArticleCard
              3-tier 渲染 (Rich 完整 X 流内同款 / Mid 仅 author / Basic 裸 URL).
              retweet 翻转时取 retweet_of.{content_resolved_url, x_article};
              否则 (原创 / quote 主推) 取 L1 extra.{content_resolved_url, x_article} */}
          {(() => {
            const sourceContent = isRetweet && retweetOf?.content ? retweetOf.content : item.content;
            const sourceResolvedUrl = isRetweet && retweetOf
              ? retweetOf.content_resolved_url
              : extra.content_resolved_url;
            const sourceArticle = isRetweet && retweetOf
              ? retweetOf.x_article
              : extra.x_article;
            if (isTcoOnly(sourceContent) && sourceResolvedUrl) {
              return (
                <XArticleCard
                  article={sourceArticle}
                  resolvedUrl={sourceResolvedUrl}
                  content={sourceContent}
                  showBody={embedded}
                />
              );
            }
            return (
              <div
                ref={bodyRef}
                className={cn(
                  "mt-1 text-[15px] leading-[1.45] text-neutral-900 break-words whitespace-pre-wrap",
                  !expanded && "line-clamp-4",
                )}
              >
                {renderRichText(expanded ? displayText : smartTruncate(displayText, 280))}
              </div>
            );
          })()}

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

          {/* Media — 视频 inline 播放（VideoCoordinator 协调），图片点击进 Lightbox。 */}
          <TweetMediaTile
            media={lightboxMedia}
            itemId={item.id}
            sourceType={item.source_type}
            onClickImage={(idx) => setLightboxIndex(idx)}
            posterMode={posterMode}
          />

          {/* F3: Reply parent 不再嵌套在 main media 之后（旧的 quote 视觉语言）。
              X 详情页用 thread 视觉语言：父推上移到主推**上方**，用 connector
              line 连接。父推渲染移到 article 顶部见下方 ReplyParentRow 块。 */}

          {/* Quoted tweet (nested card) — 拉不到原推时(被删/封)显示 X 风格「不可用」灰框,
              对齐 X 原生 "This post is unavailable",不再用顶部「引用推文」标签 */}
          {quoteOf ? (
            <QuotedTweet quote={quoteOf} posterMode={posterMode} />
          ) : hasQuotePlaceholder ? (
            <div className="mt-2.5 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-[13px] text-neutral-400">
              引用的推文已不可用
            </div>
          ) : null}

          {/* Link preview card (URL auto-expanded by X) —
              PM 2026-05-22: 过滤 link_card 指向本推文自己的 self-preview
              (twitter.com/handle/status/<本 source_id>), 底部"打开 X 原文"
              已是同款入口, 重复展示无意义 */}
          {extra.link_card && !quoteOf && !isSelfLinkCard(extra.link_card, item.handle, item.source_id) && (
            <LinkCard card={extra.link_card} />
          )}

          {/* Metrics bar (read-only X-platform data, not interactive) */}
          <MetricsRow metrics={metrics} />
        </div>
      </div>

      {lightboxIndex !== null && lightboxMedia.length > 0 && (
        <Lightbox
          media={lightboxMedia}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
      {replyLightboxIndex !== null && replyLightboxMedia.length > 0 && (
        <Lightbox
          media={replyLightboxMedia}
          startIndex={replyLightboxIndex}
          onClose={() => setReplyLightboxIndex(null)}
        />
      )}
    </article>
  );
}

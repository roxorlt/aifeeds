import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fetchItems } from "../api";
import type { Item, SourceType } from "../types";
import { VideoColumnProvider } from "../lib/videoColumnContext";
import { useIsNarrow } from "../lib/breakpoint";
import { ThreadCard } from "./ThreadCard";
import { ItemCard } from "./ItemCard";
import { ClawhubColumnHeader, type ClawhubSort, type ClawhubCategory } from "./ClawhubColumnHeader";
import { HuodongxingColumnHeader, type HdxCity, type HdxWhen, type HdxForm } from "./HuodongxingColumnHeader";
import { SourceIcon } from "./icons";
import {
  groupByThread,
  getLastSeen,
  setLastSeen,
  rowMaxScrapedAt,
  parseJsonField,
  proxyImg,
  cn,
} from "../lib/utils";
import type { ItemExtra } from "../types";
import { scrollFeedOrPage, smoothScrollToTop } from "../lib/scroll";
import { SortSelector, type SortMode } from "./SortSelector";
import { useDrawer } from "../lib/drawerContext";
import { subscribeItemUpdate } from "../lib/itemUpdateBus";
import { track, EVENTS } from "../lib/telemetry";
import {
  createFeedReadyContender,
  createFeedReadyScheduler,
  isFeedRootEligible,
  type FeedReadyDataSource,
} from "../lib/telemetry/performance-detail";
import { getPerformanceDeviceMeta } from "../lib/telemetry/vitals";
import { feedResponseNetworkSource } from "../lib/feed-prefetch";
import {
  OPTIMISTIC_FEED_START,
  resolveFeedRenderState,
} from "../lib/feedAvailability";
import {
  hasListRequestForSource,
  isFeedMounted,
  registerMountedFeed,
} from "../lib/feedScheduling";
import { getMediaLoadPolicy } from "../lib/mediaPriority";
import { newestScrapedAt } from "../lib/feedFreshness";
import {
  resolveChannelSwipeIntent,
  type ChannelSwipeIntent,
} from "../lib/motion";

// PM 2026-05-20 反馈:mobile 两 tab 来回切每次都看骨架屏。原因 — App.tsx
// <Feed key={col.source_type}> 切 tab 时 source 变 → key 变 → Feed re-mount →
// items state 清空 → 重 fetch 显 skeleton。
//
// 改造:module-level FEED_CACHE 缓存每个 sourceType 的 items / cursor / hasMore,
// Feed mount 时从 cache lazy init state(有 cache 直接显已有 items,不 skeleton);
// fetch 完成后 sync 回 cache;items 变化(load more / refresh)同步 cache。
// TTL 5min,过期视为没缓存(避免显太老数据)。
// 注:cache key = sourceType,不带其他 filter param(简化);切回时短暂显之前的
// items + 后台 fetch 当前 filter 数据,fetch 完成后立即覆盖。loadMore append 也
// 通过 items state change useEffect sync 回 cache,append 后切走再回来不丢。
type FeedCacheEntry = {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
  ts: number;
  snapshot?: boolean;
  queryTimeMs?: number;
};
const FEED_CACHE = new Map<string, FeedCacheEntry>();
const FEED_CACHE_TTL_MS = 5 * 60 * 1000;

// 本地持久化(2026-06-11,回访秒开):FEED_CACHE 同步落一份轻量快照到 localStorage,
// 下次打开 App(冷启动,内存是空的)先显示上次的内容、后台 silent refetch 换新 —— 微博/
// 小红书的"先显旧再刷新"模式。只存前 FEED_SNAP_ITEMS 条(首屏够用,控制配额);不存
// nextCursor(截断后 cursor 和 items 对不上)。快照只用于首屏占位,必须强制 silent
// refetch,否则冷启动会把 15 条快照误当完整列表并显示"到底"。
const FEED_SNAP_PREFIX = "aifeeds_feed_snap:";
const FEED_SNAP_ITEMS = 15;
const FEED_SNAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function setFeedCache(key: string, entry: FeedCacheEntry): void {
  FEED_CACHE.set(key, entry);
  try {
    localStorage.setItem(
      FEED_SNAP_PREFIX + key,
      JSON.stringify({ items: entry.items.slice(0, FEED_SNAP_ITEMS), ts: entry.ts }),
    );
  } catch {
    /* 配额满/隐私模式 → 忽略,纯内存照常工作 */
  }
}

function readFeedCache(key: string, maxAgeMs: number = FEED_CACHE_TTL_MS): FeedCacheEntry | null {
  const c = FEED_CACHE.get(key);
  if (c) return Date.now() - c.ts <= maxAgeMs ? c : null;
  // 内存 miss(冷启动)→ 尝试 localStorage 快照,命中则 hydrate 回内存
  try {
    const raw = localStorage.getItem(FEED_SNAP_PREFIX + key);
    if (!raw) return null;
    const snap = JSON.parse(raw) as { items?: Item[]; ts?: number };
    if (!snap || !Array.isArray(snap.items) || snap.items.length === 0 || !snap.ts) return null;
    const entry: FeedCacheEntry = { items: snap.items, nextCursor: null, hasMore: true, ts: snap.ts, snapshot: true };
    FEED_CACHE.set(key, entry);
    return Date.now() - snap.ts <= maxAgeMs ? entry : null;
  } catch {
    return null;
  }
}

// 单频道后台预取由 App 的全局串行队列调度。每项真正执行时重新检查 mount/cache/in-flight，
// 避免排队期间用户已经滚动挂载后再发重复请求。ClawHub/活动默认带筛选，而当前 cache key
// 只有 sourceType；为避免错误 hydrate，本阶段不后台预取这两个频道。
const PREFETCH_LIMIT = 12;
// App's page-level scheduler must call the same cache-aware list path as Feed;
// keeping this narrow export here avoids duplicating FEED_CACHE ownership.
// eslint-disable-next-line react-refresh/only-export-components
export async function prefetchChannel(
  sourceType: SourceType | "blog,podcast",
): Promise<void> {
  if (sourceType === "clawhub" || sourceType === "huodongxing") return;
  if (
    isFeedMounted(sourceType)
    || readFeedCache(sourceType)
    || hasListRequestForSource(sourceType)
  ) return;

  const response = await fetchItems({
    source_type: sourceType,
    limit: PREFETCH_LIMIT,
    sort: sourceType === "blog,podcast" ? "published_at" : undefined,
  }, { purpose: "background" });
  if (response.items.length === 0 || readFeedCache(sourceType)) return;
  setFeedCache(sourceType, {
    items: response.items,
    nextCursor: response.next_cursor,
    hasMore: response.has_more,
    ts: Date.now(),
    queryTimeMs: response.query_time_ms,
  });
}

interface Props {
  // 「官方新闻」合并频道（D7）以逗号复合值 "blog,podcast" 传入；其余源是单个
  // SourceType。复合值仅在 fetchItems 时拆数组，其它地方当 string key 用。
  sourceType: SourceType | "blog,podcast";
  title: string;
  placeholder?: boolean;
  refreshTick: number;
  onInitialRequestStart?: () => void;
  onInitialRequestSettled?: () => void;
  mediaColumnIndex: number;
  mediaColumnImmediate: boolean;
}

const INITIAL_LIMIT = 12;
const LOAD_MORE_LIMIT = 30;
const POLL_INTERVAL_MS = 30_000;
const PULL_THRESHOLD = 60;
const PULL_RESISTANCE = 2.5;
const PULL_MAX = 110;
const PULL_SLOT_HEIGHT = 46;
// After this long of page-visible time, commit current top item to localStorage
// as the new last-seen boundary. Next visit's waistband will sit just below it.
// Commit the current top item as "seen" after this much *visible* page time.
// Timer is paused while the tab is hidden — so if the user opens the tab but
// never looks at it, last-seen stays where it was.
const MARK_SEEN_DELAY_MS = 5_000;

// 页面级 singleton：PC 多列同时 commit、mobile tab remount/refresh/load-more 都只能
// 让最先实际 paint 的 Feed 上报一次。每列各排 RAF，StrictMode/卸载只 cancel 自己，
// 不会误伤其它仍挂载的 contender。
const feedReadyScheduler = createFeedReadyScheduler({
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (id) => window.cancelAnimationFrame(id),
  report: (payload) => {
    try {
      performance.mark("aifeeds:feed-ready");
    } catch {
      // The milestone remains telemetry-only on browsers without User Timing.
    }
    track(EVENTS.FEED_READY, payload);
  },
});

// Network Information API is non-standard but supported on Chrome/Edge/
// Android Chrome (i.e. the bulk of mobile traffic). Use it for telemetry
// only — feature-detect at call-time and degrade silently elsewhere.
type NavConn = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
};
function readConnectionInfo(): {
  connection_type?: string;
  downlink?: number;
  rtt?: number;
  save_data?: boolean;
} {
  const conn = (navigator as Navigator & { connection?: NavConn }).connection;
  if (!conn) return {};
  return {
    connection_type: conn.effectiveType,
    downlink: conn.downlink,
    rtt: conn.rtt,
    save_data: conn.saveData,
  };
}

function PendingAvatars({ pending }: { pending: Item[] }) {
  // Pick up to 3 unique-handle avatars from the pending queue (newest first).
  const avatars: { url: string; handle: string }[] = [];
  const seen = new Set<string>();
  for (const it of pending) {
    const handle = it.handle || "";
    if (!handle || seen.has(handle)) continue;
    const extra = parseJsonField<ItemExtra>(it.extra);
    const url = extra?.profile_image_url;
    if (!url) continue;
    seen.add(handle);
    avatars.push({ url, handle });
    if (avatars.length >= 3) break;
  }
  if (avatars.length === 0) {
    return <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />;
  }
  return (
    <div className="flex -space-x-2">
      {avatars.map((a, i) => (
        <img
          key={a.handle}
          src={proxyImg(a.url, 80)}
          alt={a.handle}
          className="h-5 w-5 rounded-full ring-2 ring-blue-50 object-cover"
          style={{ zIndex: avatars.length - i }}
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      ))}
    </div>
  );
}

// R18 PM 反馈: 切换前 / 切换中 / 切换后 三处 skeleton 样式不一致, 看 3 屏闪.
// export 让 App.tsx 的 channel transition overlay / adjacent panel 共用同款,
// 视觉上 skeleton 一致, 只是 mount 位置变化, 用户感受切换连续.
export function SkeletonCard() {
  return (
    <div className="border-b border-neutral-200 px-3 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-200 animate-pulse" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-24 rounded bg-neutral-200 animate-pulse" />
          <div className="h-2.5 w-16 rounded bg-neutral-100 animate-pulse" />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-3 rounded bg-neutral-100 animate-pulse" />
        <div className="h-3 w-5/6 rounded bg-neutral-100 animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-neutral-100 animate-pulse" />
      </div>
    </div>
  );
}

export interface FeedHandle {
  scrollToTop: (options?: { instant?: boolean }) => void;
}

export const Feed = forwardRef<FeedHandle, Props>(function Feed(
  {
    sourceType,
    title,
    placeholder: placeholderFromMetadata,
    refreshTick,
    onInitialRequestStart,
    onInitialRequestSettled,
    mediaColumnIndex,
    mediaColumnImmediate,
  },
  ref,
) {
  // PM 2026-05-20:从 FEED_CACHE 拿之前缓存的 items,有 cache 时 mount 直接显
  // (不显 skeleton),background refetch 更新。lazy init 保证只在 mount 时读一次。
  // 2026-06-11:展示场景放宽到 24h(localStorage 快照)— 冷启动先秒显上次内容,
  // mount effect 里的 silent refetch(只认 60s 内新鲜缓存)马上换新。
  const cachedInit = readFeedCache(sourceType, FEED_SNAP_MAX_AGE_MS);
  const [items, setItems] = useState<Item[]>(cachedInit?.items ?? []);
  const [pending, setPending] = useState<Item[]>([]);
  // PM 2026-05-25 R11: 有 cache 不显 loading; 无 cache 初始 true 让 mount 那一帧
  // 立即显 skeleton (不留 mount → useEffect fetch 之间的空白帧, 配 channel
  // transition overlay fade-out 无缝衔接)
  const [loading, setLoading] = useState(!cachedInit);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastScrapedAt = useRef<string | null>(newestScrapedAt(cachedInit?.items ?? []));
  const [retryTick, setRetryTick] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(cachedInit?.nextCursor ?? null);
  const [hasMore, setHasMore] = useState(cachedInit?.hasMore ?? true);
  const feedReadySourceRef = useRef<FeedReadyDataSource>(
    cachedInit ? (cachedInit.snapshot ? "local_snapshot" : "memory_cache") : "network",
  );
  const feedReadyQueryTimeRef = useRef<number | undefined>(
    cachedInit?.snapshot ? undefined : cachedInit?.queryTimeMs,
  );
  // Cooldown: after N consecutive load_more failures we stop auto-firing
  // loadMore via IntersectionObserver and show a manual retry button.
  // Telemetry showed bursts of 30+ failures in 45s on WeChat WebView —
  // the observer kept re-triggering as the user scrolled, each fetch
  // failed, and we burned battery + log noise without recourse for the
  // user. Tap on retry resets the counter.
  const LOAD_MORE_FAIL_THRESHOLD = 3;
  const consecutiveFailRef = useRef(0);
  const [loadMoreCoolingDown, setLoadMoreCoolingDown] = useState(false);
  // 所有源默认按时间倒序起步（review 反馈：X 默认也用「时间」）。X 仍可通过
  // SortSelector 切到 hot；GitHub / PH / 活动行的 sort 由各自列头自管，sortMode
  // 在它们身上 effectively no-op。
  const [sortMode, setSortMode] = useState<SortMode>("time");
  // ClawHub 专属筛选维度（覆盖 sortMode）：sort + category + hideSuspicious 通过 query param 传 worker
  const [chSort, setChSort] = useState<ClawhubSort>("stars");
  // category 默认每次 mount 随机选一个非 all 类（review 反馈：默认随机一个分类，
  // 让首屏不每次都看全部，鼓励"今天看点别的"）。useState lazy init 保证只随机一次。
  const [chCategory, setChCategory] = useState<ClawhubCategory>(() => {
    if (sourceType !== "clawhub") return "all";
    const opts: ClawhubCategory[] = [
      "mcp-tools", "prompts", "workflows", "dev-tools",
      "data", "security", "automation", "other",
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  });
  const [chHideSuspicious, setChHideSuspicious] = useState<boolean>(true);
  const isClawhub = sourceType === "clawhub";
  const isGh = sourceType === "github";
  // 活动行专属筛选：city / when / form 三个 query param 透传 worker
  // 默认值：北京 / 本周 / 线下 — 大多数用户最常看的组合（按 2026-05-13 review 反馈）
  const [hdxCity, setHdxCity] = useState<HdxCity>(sourceType === "huodongxing" ? "北京" : "");
  const [hdxWhen, setHdxWhen] = useState<HdxWhen>(sourceType === "huodongxing" ? "this" : "");
  const [hdxForm, setHdxForm] = useState<HdxForm>(sourceType === "huodongxing" ? "offline" : "");
  // PH 跟 ClawHub 同样：不轮询新产品（每天 04:10 cron 一次性更新）、
  // 不显示"N 个新产品"横幅、不走曝光过滤（time 模式 + 日榜性质）。
  const isPh = sourceType === "product_hunt";
  // huodongxing 同：BJT 04:30 + 16:30 cron 抓全部，新内容是离散的活动条目，
  // 不需要轮询 / 曝光过滤；worker 已经按"状态优先 + start_time ASC"排好。
  const isHdx = sourceType === "huodongxing";
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const feedRootRef = useRef<HTMLDivElement | null>(null);
  const feedBodyRef = useRef<HTMLDivElement | null>(null);
  const [feedReadyEligible, setFeedReadyEligible] = useState(false);
  const isNarrowFeed = useIsNarrow();
  const [isRefreshingPull, setIsRefreshingPull] = useState(false);
  const pullIndicatorRef = useRef<HTMLDivElement | null>(null);
  const pullLabelRef = useRef<HTMLSpanElement | null>(null);
  const pullStart = useRef<{ x: number; y: number } | null>(null);
  const pullTouchId = useRef<number | null>(null);
  const pullIntent = useRef<ChannelSwipeIntent>("unknown");
  const pullYRef = useRef(0);
  const loadingRef = useRef(false);
  const isDraggingRef = useRef(false);
  // 切回频道秒切:本 Feed 实例是否已发过初次请求。首次 mount 时若 FEED_CACHE 够新就跳过 refetch。
  const didFetchRef = useRef(false);
  // App withdraws the per-refresh unlock capability as soon as the first mounted
  // Feed starts. Keeping the latest prop in a ref avoids restarting that in-flight
  // request, while a later Feed remount sees undefined and may use the 60s cache skip.
  const onInitialRequestStartRef = useRef(onInitialRequestStart);
  onInitialRequestStartRef.current = onInitialRequestStart;
  const onInitialRequestSettledRef = useRef(onInitialRequestSettled);
  onInitialRequestSettledRef.current = onInitialRequestSettled;
  // With optimistic start enabled, metadata reconciliation may remove a channel
  // after useful content already committed. Keep only that committed content: a
  // late response excluded in the same render cannot bypass metadata or set the latch.
  const hasRenderedItemsRef = useRef(false);
  const feedRenderState = resolveFeedRenderState({
    enabled: OPTIMISTIC_FEED_START,
    metadataPlaceholder: Boolean(placeholderFromMetadata),
    itemCount: items.length,
    hadRenderedItems: hasRenderedItemsRef.current,
  });
  const placeholder = feedRenderState.placeholder;
  useEffect(() => {
    if (placeholder) return;
    return registerMountedFeed(sourceType);
  }, [placeholder, sourceType]);
  useEffect(() => {
    if (feedRenderState.nextHadRenderedItems) {
      hasRenderedItemsRef.current = feedRenderState.nextHadRenderedItems;
    }
  }, [feedRenderState.nextHadRenderedItems]);
  const placeholderRef = useRef(Boolean(placeholder));
  placeholderRef.current = Boolean(placeholder);
  const isCurrentFeedEligible = useCallback(() => (
    !placeholderRef.current && isFeedRootEligible(feedRootRef.current, {
      documentVisible: document.visibilityState !== "hidden" && !document.hidden,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
  ), []);
  const feedReadyContenderRef = useRef<ReturnType<typeof createFeedReadyContender> | null>(null);
  if (!feedReadyContenderRef.current) {
    feedReadyContenderRef.current = createFeedReadyContender({
      scheduler: feedReadyScheduler,
      isEligible: isCurrentFeedEligible,
    });
  }

  const isHot = sortMode === "hot";

  // Only a currently visible Feed may compete for the page-level milestone. IO handles
  // PC grid rows and mobile tab transforms; visibilitychange covers background tabs.
  // The live predicate is checked again inside RAF by createFeedReadyContender.
  useEffect(() => {
    const root = feedRootRef.current;
    if (!root || placeholder) {
      setFeedReadyEligible(false);
      return;
    }
    const updateEligibility = () => setFeedReadyEligible(isCurrentFeedEligible());
    updateEligibility();
    document.addEventListener("visibilitychange", updateEligibility);
    window.addEventListener("resize", updateEligibility);

    let observer: IntersectionObserver | null = null;
    const hasIntersectionObserver = typeof IntersectionObserver !== "undefined";
    if (hasIntersectionObserver) {
      observer = new IntersectionObserver(updateEligibility, { threshold: 0 });
      observer.observe(root);
    } else {
      window.addEventListener("scroll", updateEligibility, { passive: true });
    }
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", updateEligibility);
      window.removeEventListener("resize", updateEligibility);
      if (!hasIntersectionObserver) window.removeEventListener("scroll", updateEligibility);
    };
  }, [placeholder, sourceType, isCurrentFeedEligible]);

  // items 已在本次 commit 中成为非空后，再等一帧，记录用户真正看到首流的时刻。
  // payload 在排帧时快照，避免 silent refetch 抢先改写 cache provenance。
  useEffect(() => {
    if (placeholder || items.length === 0 || !feedReadyEligible) return;
    const queryTime = feedReadyQueryTimeRef.current;
    return feedReadyContenderRef.current?.setup({
      source_type: sourceType,
      item_count: items.length,
      data_source: feedReadySourceRef.current,
      query_time_ms: Number.isFinite(queryTime) ? queryTime : undefined,
      ...getPerformanceDeviceMeta(),
    });
  }, [placeholder, sourceType, items.length, feedReadyEligible]);

  // PM 2026-05-20:items / nextCursor / hasMore 变化时 sync 回 FEED_CACHE,
  // 让 loadMore append / drawer 单条更新 / refresh 拉新都被记住,切 tab
  // 再回来时仍能 hydrate 完整 list(否则切走丢 append 部分,scroll 位置
  // 看起来"少了一截")。items 为空时不写(避免覆盖错误状态污染 cache)
  useEffect(() => {
    if (placeholder) return;
    if (items.length === 0) return;
    // ts 保留已有值(= 数据真正从网络拿到的时间),不在 sync 时重新盖章 —— 否则
    // mount 时这个 effect 会把 localStorage 恢复的旧快照重新标成"新鲜",让下面
    // fetch effect 的 60s skip 误判,silent refetch 被跳过,用户停在旧内容上。
    const previous = FEED_CACHE.get(sourceType);
    setFeedCache(sourceType, {
      items,
      nextCursor,
      hasMore,
      ts: previous?.ts ?? Date.now(),
      snapshot: previous?.snapshot,
      queryTimeMs: previous?.queryTimeMs,
    });
  }, [sourceType, items, nextCursor, hasMore, placeholder]);

  // 订阅 drawer 单条更新：抽屉打开触发的 lazy-enrich 拿到 fresh.item 后，
  // 把 feed 列表里同 id 的那张卡片也替换掉，避免抽屉新 / feed 老。
  useEffect(() => {
    return subscribeItemUpdate((updated) => {
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      setPending((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    });
  }, []);

  // Initial load + refresh on tick or sort change
  useEffect(() => {
    if (placeholder) {
      // A manifest change can turn a channel into a placeholder while its
      // optimistic list request is still in flight. Keep the reveal slot until
      // that request's finally handler runs; a never-started placeholder can
      // release immediately.
      if (!didFetchRef.current) onInitialRequestSettledRef.current?.();
      return;
    }
    // 切回频道秒切:本实例首次 mount + FEED_CACHE 够新(<60s)→ 不重拉,直接用 hydrate 的缓存。
    // 下拉刷新 / 换排序会让 deps 变,届时 didFetchRef 已 true → 照常拉新。
    if (!didFetchRef.current) {
      didFetchRef.current = true;
      const fresh = readFeedCache(sourceType);
      if (!onInitialRequestStartRef.current && fresh?.items.length && !fresh.snapshot && Date.now() - fresh.ts < 60_000) {
        onInitialRequestSettledRef.current?.();
        return;
      }
    }
    let cancelled = false;
    // PM 2026-05-20:若已有 cache hydrate 的 items,后台静默 refetch
    // (loading=false,不显 skeleton);否则首次进 tab 显 skeleton
    const hasHydrated = Boolean(readFeedCache(sourceType)?.items.length);
    if (!hasHydrated) setLoading(true);
    setError(null);
    const request = fetchItems({
      source_type: sourceType,
      limit: INITIAL_LIMIT,
      // 官方新闻必须显式 sort=published_at:默认 scraped_at 在批量回灌时同秒
      // 入库,排序退化成 id 序(实测乱跳「5个月前→2个月前→8个月前」)。
      sort: isClawhub ? chSort : (isHot ? "hot" : sourceType === "blog,podcast" ? "published_at" : undefined),
      category: isClawhub && chCategory !== "all" ? chCategory : undefined,
      include_suspicious: isClawhub && !chHideSuspicious ? true : undefined,
      city: isHdx && hdxCity ? hdxCity : undefined,
      when: isHdx && hdxWhen ? hdxWhen : undefined,
      form: isHdx && hdxForm ? hdxForm : undefined,
    });
    onInitialRequestStartRef.current?.();
    request
      .then((res) => {
        if (cancelled) return;
        feedReadySourceRef.current = feedResponseNetworkSource(res);
        feedReadyQueryTimeRef.current = res.query_time_ms;
        const itemsToShow = res.items;
        setItems(itemsToShow);
        setPending([]);
        setNextCursor(res.next_cursor);
        setHasMore(res.has_more);
        lastScrapedAt.current = newestScrapedAt(res.items);
        // 写入 FEED_CACHE,下次 mount 时直接 hydrate(不 skeleton)
        setFeedCache(sourceType, {
          items: itemsToShow,
          nextCursor: res.next_cursor,
          hasMore: res.has_more,
          ts: Date.now(),
          queryTimeMs: res.query_time_ms,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        const errMsg = String(e);
        setError(errMsg);
        track(EVENTS.FEED_LOAD_ERROR, {
          source_type: sourceType,
          sort: isHot ? "hot" : "time",
          phase: "initial",
          error_msg: errMsg,
          online: navigator.onLine,
          ...readConnectionInfo(),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        onInitialRequestSettledRef.current?.();
      });
    return () => {
      cancelled = true;
    };
  }, [sourceType, placeholder, refreshTick, retryTick, isHot, isClawhub, chSort, chCategory, chHideSuspicious, isHdx, hdxCity, hdxWhen, hdxForm]);

  const loadMore = useCallback(async () => {
    if (placeholder || loadingMore || !hasMore || !nextCursor) return;
    if (consecutiveFailRef.current >= LOAD_MORE_FAIL_THRESHOLD) return;
    setLoadingMore(true);
    try {
      const res = await fetchItems({
        source_type: sourceType,
        cursor: nextCursor,
        limit: LOAD_MORE_LIMIT,
        sort: isClawhub ? chSort : (isHot ? "hot" : sourceType === "blog,podcast" ? "published_at" : undefined),
        category: isClawhub && chCategory !== "all" ? chCategory : undefined,
        include_suspicious: isClawhub && !chHideSuspicious ? true : undefined,
        city: isHdx && hdxCity ? hdxCity : undefined,
        when: isHdx && hdxWhen ? hdxWhen : undefined,
        form: isHdx && hdxForm ? hdxForm : undefined,
      });
      consecutiveFailRef.current = 0;
      setItems((prev) => {
        const existing = new Set(prev.map((i) => i.id));
        const fresh = res.items.filter(
          (i) => !existing.has(i.id),
        );
        return [...prev, ...fresh];
      });
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch (e) {
      consecutiveFailRef.current += 1;
      if (consecutiveFailRef.current >= LOAD_MORE_FAIL_THRESHOLD) {
        setLoadMoreCoolingDown(true);
      }
      track(EVENTS.FEED_LOAD_ERROR, {
        source_type: sourceType,
        sort: isHot ? "hot" : "time",
        phase: "load_more",
        error_msg: e instanceof Error ? e.message : String(e),
        online: navigator.onLine,
        consecutive_fails: consecutiveFailRef.current,
        ...readConnectionInfo(),
      });
    } finally {
      setLoadingMore(false);
    }
  }, [placeholder, loadingMore, hasMore, nextCursor, sourceType, isHot, isClawhub, chSort, chCategory, chHideSuspicious, isHdx, hdxCity, hdxWhen, hdxForm]);

  const retryLoadMore = useCallback(() => {
    consecutiveFailRef.current = 0;
    setLoadMoreCoolingDown(false);
    void loadMore();
  }, [loadMore]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (placeholder || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const scrollRoot = el.closest(".feed-body");
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { root: scrollRoot, rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [placeholder, hasMore, loadMore]);

  // Release the pull spinner once the refresh actually completes.
  useEffect(() => {
    if (isRefreshingPull && !loading) setIsRefreshingPull(false);
  }, [isRefreshingPull, loading]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const updatePullIndicator = useCallback((value: number, animate: boolean, refreshing = false) => {
    const indicator = pullIndicatorRef.current;
    const label = pullLabelRef.current;
    if (!indicator) return;
    const progress = Math.min(value / PULL_THRESHOLD, 1);
    indicator.style.transition = animate
      ? "transform 180ms cubic-bezier(0.23, 1, 0.32, 1), opacity 150ms cubic-bezier(0.23, 1, 0.32, 1)"
      : "none";
    indicator.style.transform = `translateY(${-PULL_SLOT_HEIGHT + progress * PULL_SLOT_HEIGHT}px)`;
    indicator.style.opacity = value > 0 || refreshing ? "1" : "0";
    if (label) {
      label.textContent = refreshing
        ? "正在刷新"
        : value > PULL_THRESHOLD
          ? "松手刷新"
          : "下拉刷新";
    }
  }, []);

  useEffect(() => {
    updatePullIndicator(
      isRefreshingPull ? PULL_THRESHOLD : 0,
      true,
      isRefreshingPull,
    );
  }, [isRefreshingPull, updatePullIndicator]);

  // Native touch listeners so we can preventDefault in touchmove — React attaches
  // its synthetic touchmove as a passive listener, so the browser's own pull-down
  // behavior wins and the finger never "drags" the feed.
  useEffect(() => {
    if (placeholder) return;
    // Only activate PRR on mobile — PC uses bounded cell scroll, no pull gesture
    if (!isNarrowFeed) return;

    // R21: mobile body fixed 架构后 window.scrollY 永远 0, 用 getScrollY 兜底
    const isAtTop = () => {
      const root = document.getElementById("root");
      return (root ? root.scrollTop : window.scrollY) <= 0;
    };

    const resetPullGesture = (animate: boolean) => {
      pullStart.current = null;
      pullTouchId.current = null;
      pullIntent.current = "unknown";
      pullYRef.current = 0;
      isDraggingRef.current = false;
      if (!isRefreshingPull) updatePullIndicator(0, animate);
    };

    const findPullTouch = (touches: TouchList) => (
      pullTouchId.current === null
        ? undefined
        : Array.from(touches).find((touch) => touch.identifier === pullTouchId.current)
    );

    const onStart = (e: TouchEvent) => {
      if (isRefreshingPull) {
        resetPullGesture(false);
        return;
      }
      if (e.touches.length !== 1) {
        resetPullGesture(true);
        return;
      }
      // Skip when touch starts in any non-feed zone — drawer, app header,
      // or column header. PRR is for the feed cards area only; firing it
      // from non-scroll zones would steal vertical motion and trigger
      // the pull-spinner where the user just wanted to tap.
      // (Drawer guard: heroui#5974 / vaul#168 — non-passive touchmove on
      // window blocks the drawer's own scroll otherwise.)
      const target = e.target as Element | null;
      if (
        target?.closest('[role="dialog"]') ||
        target?.closest("[data-no-page-scroll]")
      ) {
        resetPullGesture(true);
        return;
      }
      if (isAtTop()) {
        const touch = e.touches[0];
        pullStart.current = { x: touch.clientX, y: touch.clientY };
        pullTouchId.current = touch.identifier;
        pullIntent.current = "unknown";
        pullYRef.current = 0;
        isDraggingRef.current = false;
      } else {
        resetPullGesture(true);
      }
    };
    const onMove = (e: TouchEvent) => {
      const start = pullStart.current;
      if (!start) return;
      if (e.touches.length !== 1) {
        resetPullGesture(true);
        return;
      }
      const touch = findPullTouch(e.touches);
      if (!touch) {
        resetPullGesture(true);
        return;
      }
      if (!isAtTop()) {
        resetPullGesture(true);
        return;
      }
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (pullIntent.current === "unknown") {
        const intent = resolveChannelSwipeIntent(dx, dy);
        if (intent === "unknown") return;
        if (intent === "horizontal" || dy <= 0) {
          resetPullGesture(true);
          return;
        }
        pullIntent.current = "vertical";
      }
      if (dy > 0) {
        if (e.cancelable) e.preventDefault();
        isDraggingRef.current = true;
        const next = Math.min(dy / PULL_RESISTANCE, PULL_MAX);
        pullYRef.current = next;
        updatePullIndicator(next, false);
      }
    };
    const onEnd = (e: TouchEvent) => {
      const activeTouchEnded = pullTouchId.current !== null
        && Array.from(e.changedTouches).some((touch) => touch.identifier === pullTouchId.current);
      const shouldRefresh =
        activeTouchEnded &&
        e.touches.length === 0 &&
        pullStart.current !== null &&
        pullIntent.current === "vertical" &&
        pullYRef.current > PULL_THRESHOLD &&
        !loadingRef.current;
      if (shouldRefresh) {
        setIsRefreshingPull(true);
        // Cached feeds deliberately avoid toggling loading in the fetch effect.
        // Enter it here so the refresh indicator stays mounted until that exact
        // retry request reaches its finally handler.
        setLoading(true);
        setRetryTick((t) => t + 1);
      }
      pullYRef.current = 0;
      isDraggingRef.current = false;
      if (!shouldRefresh) updatePullIndicator(0, true);
      pullStart.current = null;
      pullTouchId.current = null;
      pullIntent.current = "unknown";
    };
    const onCancel = () => {
      resetPullGesture(true);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onCancel);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onCancel);
    };
  }, [placeholder, updatePullIndicator, isRefreshingPull, isNarrowFeed]);

  // Hot mode: if the initial fetch or a page-load returns items that all get
  // filtered out as "seen", items becomes empty but hasMore is still true.
  // Auto-chain into the next page so the user doesn't see a dead empty state.
  useEffect(() => {
    // ClawHub 不走曝光过滤，所以不会出现"items 全空 hasMore=true"的死页；跳过 chain
    if (
      !placeholder &&
      isHot &&
      !isClawhub &&
      !loading &&
      !loadingMore &&
      hasMore &&
      nextCursor &&
      items.length === 0
    ) {
      loadMore();
    }
  }, [placeholder, isHot, isClawhub, loading, loadingMore, hasMore, nextCursor, items.length, loadMore]);

  // Polling for new items. In time mode we prepend to `pending` and let the
  // banner show "N 条新内容"; click prepends + scrolls to top. In hot mode the
  // sort is score-based, so newly-scraped items may not belong at the top —
  // we still count them, but clicking the banner triggers a full re-fetch with
  // fresh hot ranking instead of prepending stale positions.
  // 只有 x_list(实时推文)需要 30s 轮询拉新。其余源(github / PH / clawhub / hf_paper /
  // huodongxing)都是每天 cron 一次性更新,轮询不仅没意义,还会用陈旧的 since(如 github
  // since 两周前)去拉超大结果集 → 5s 超时报 api_error(2026-06-09 排查:超时 349 条几乎
  // 全是这些非实时源的 poll)。所以只对 x_list / 默认混合流轮询。
  useEffect(() => {
    if (placeholder || (sourceType && !sourceType.includes('x_list'))) return;
    const poll = async () => {
      if (!lastScrapedAt.current) return;
      try {
        const res = await fetchItems({
          source_type: sourceType,
          since: lastScrapedAt.current,
          limit: 50,
        }, { purpose: "background" });
        const existingIds = new Set([...items, ...pending].map((i) => i.id));
        const fresh = res.items.filter((i) => !existingIds.has(i.id));
        if (fresh.length > 0) {
          setPending((prev) => [...fresh, ...prev]);
          lastScrapedAt.current = newestScrapedAt(fresh) ?? lastScrapedAt.current;
        }
      } catch {
        // Silent fail — next poll will retry
      }
    };
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sourceType, placeholder, items, pending]);

  const showPending = () => {
    if (isHot) {
      // Hot mode: re-fetch top of feed so items land in correct score-sorted
      // positions (not blindly prepended). Keep `pending` in place until the
      // fetch succeeds so the banner stays visible as a retry affordance.
      setLoading(true);
      fetchItems({
        source_type: sourceType,
        limit: INITIAL_LIMIT,
        sort: "hot",
      })
        .then((res) => {
          setItems(res.items);
          setPending([]);
          setNextCursor(res.next_cursor);
          setHasMore(res.has_more);
          if (res.items.length > 0) {
            lastScrapedAt.current = newestScrapedAt(res.items);
          }
          scrollFeedOrPage(feedBodyRef.current);
        })
        .catch(() => {
          // Keep pending so banner remains as retry affordance.
        })
        .finally(() => setLoading(false));
      return;
    }
    setItems((prev) => [...pending, ...prev]);
    setPending([]);
    scrollFeedOrPage(feedBodyRef.current);
  };

  // Capture last-seen boundary ONCE at mount — stays stable through the session
  // so the waistband position doesn't shift while the user reads.
  const initialLastSeenRef = useRef<string | null>(null);
  const initializedLastSeen = useRef(false);
  if (!initializedLastSeen.current && !placeholder) {
    initialLastSeenRef.current = getLastSeen(sourceType);
    initializedLastSeen.current = true;
  }

  // After MARK_SEEN_DELAY_MS of visible page time, commit current top item as
  // the new last-seen boundary in localStorage. Also commit on visibility hidden.
  // Skip in hot mode — "top" is not chronological there.
  useEffect(() => {
    if (placeholder || isHot || items.length === 0) return;
    const topScrapedAt = items[0].scraped_at;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const commit = () => setLastSeen(sourceType, topScrapedAt);
    const scheduleCommit = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, MARK_SEEN_DELAY_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        // Don't commit immediately on hidden — otherwise a brief tab switch
        // would lock in the current top as "seen" even if user hasn't actually
        // looked at it. Just clear the timer; next visible will reschedule.
        if (timer) clearTimeout(timer);
      } else {
        scheduleCommit();
      }
    };

    if (!document.hidden) scheduleCommit();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sourceType, placeholder, items, isHot]);

  const { spotlightItem, clearSpotlight } = useDrawer();

  // ClawHub: 当排序/分类/隐藏可疑任一变更时，释放当前 pin 在顶部的 spotlight，
  // 否则那条 item 会继续置顶但不符合新筛选条件。挂在 mount 后跳过首次（避免
  // 进入页面就误清新设置的 spotlight）。
  const filterChangeIgnoreRef = useRef(true);
  useEffect(() => {
    if (!isClawhub) return;
    if (filterChangeIgnoreRef.current) {
      filterChangeIgnoreRef.current = false;
      return;
    }
    clearSpotlight();
  }, [isClawhub, chSort, chCategory, chHideSuspicious, clearSpotlight]);

  // 同上 — 活动行的 city / when / form 筛选变更时也释放 spotlight
  const hdxFilterChangeIgnoreRef = useRef(true);
  useEffect(() => {
    if (!isHdx) return;
    if (hdxFilterChangeIgnoreRef.current) {
      hdxFilterChangeIgnoreRef.current = false;
      return;
    }
    clearSpotlight();
  }, [isHdx, hdxCity, hdxWhen, hdxForm, clearSpotlight]);

  // Inject the spotlight tweet (from cold-link or in-app drawer open) at the
  // top of this column's data, so closing the drawer leaves the user able to
  // find it. Only applies to columns matching the spotlight's source_type.
  //
  // F4: 即使 spotlight 已在 feed 里（按时间倒序中某位置），也强制提到顶部 —
  // 用户刚关上的抽屉对应的卡片应当在 feed 第一位 (旧的 dedup 逻辑会让
  // spotlight 沉到原位置，用户看不到"假写"效果，等同于功能丢失)。
  const itemsWithSpotlight = useMemo(() => {
    if (!spotlightItem) return items;
    if (spotlightItem.source_type !== sourceType) return items;
    const filtered = items.filter((i) => i.id !== spotlightItem.id);
    return [spotlightItem, ...filtered];
  }, [items, spotlightItem, sourceType]);

  const rows = useMemo(() => groupByThread(itemsWithSpotlight), [itemsWithSpotlight]);

  // Find the waistband insertion index: first row whose newest scraped_at is
  // <= initialLastSeen (i.e., the first "already seen" row). Returns -1 if
  // either everything is new (not loaded enough) or everything is seen.
  // Always -1 in hot mode since rows aren't chronologically ordered.
  const waistbandIndex = useMemo(() => {
    if (isHot) return -1;
    const boundary = initialLastSeenRef.current;
    if (!boundary || rows.length === 0) return -1;
    let firstSeen = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rowMaxScrapedAt(rows[i]) <= boundary) {
        firstSeen = i;
        break;
      }
    }
    // Only show divider if there's at least one unseen row above it, otherwise
    // the "上次看到这里" line would appear at the very top with nothing new.
    if (firstSeen <= 0) return -1;
    return firstSeen;
  }, [rows, isHot]);

  useImperativeHandle(ref, () => ({
    scrollToTop: (options) => smoothScrollToTop(
      feedBodyRef.current,
      options?.instant ? { duration: 0 } : {},
    ),
  }));

  return (
    <VideoColumnProvider
      columnId={sourceType}
      // PC：每列独立 scroll container（feed-body）→ IO root 是它
      // mobile：单列文档流滚 → root=null = viewport
      scrollRoot={isNarrowFeed ? null : feedBodyRef}
      hotZoneRatio={isNarrowFeed ? 0.6 : 0.5}
    >
    <div ref={feedRootRef} data-feed-source={sourceType} className="flex flex-col overflow-hidden bg-white md:h-[70vh] md:max-h-[70vh] md:rounded-lg md:border md:border-neutral-200 md:shadow-sm">
      {/* Header — marked `data-no-page-scroll` so the App-level touch
          handler blocks page-scroll initiation from this strip on mobile.
          (touch-action: pan-x is unreliable on iOS Safari / WeChat WebView
          per WebKit bug 133112; the JS handler in App.tsx is the actual
          enforcer.) Tap (sort dropdown, etc.) still works since the
          handler only preventDefault's touchmove. PC unaffected — touch
          handlers don't fire for mouse. */}
      <header
        data-no-page-scroll
        className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 max-md:touch-pan-x md:cursor-pointer"
        onClick={(e) => {
          // Mobile: chip rail handles回顶 via active-tap; skip header tap
          if (window.matchMedia("(max-width: 767px)").matches) return;
          // Skip when click bubbled from a button (sort selector, refresh)
          if ((e.target as HTMLElement).closest("button")) return;
          smoothScrollToTop(feedBodyRef.current);
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <SourceIcon
            source_type={sourceType}
            className="h-4 w-4 shrink-0 fill-current text-neutral-700"
          />
          <span className="truncate text-sm font-semibold text-neutral-900">
            {title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!placeholder && isClawhub && (
            <ClawhubColumnHeader
              sort={chSort}
              category={chCategory}
              hideSuspicious={chHideSuspicious}
              onSortChange={(next) => {
                if (next !== chSort) {
                  track(EVENTS.SORT_CHANGE, { from: chSort, to: next, source: sourceType });
                  setChSort(next);
                }
              }}
              onCategoryChange={(next) => {
                if (next !== chCategory) {
                  track(EVENTS.SORT_CHANGE, { from: `cat:${chCategory}`, to: `cat:${next}`, source: sourceType });
                  setChCategory(next);
                }
              }}
              onHideSuspiciousChange={(next) => {
                track(EVENTS.SORT_CHANGE, { from: `susp:${chHideSuspicious}`, to: `susp:${next}`, source: sourceType });
                setChHideSuspicious(next);
              }}
            />
          )}
          {!placeholder && isHdx && (
            <HuodongxingColumnHeader
              city={hdxCity}
              when={hdxWhen}
              form={hdxForm}
              onCityChange={(next) => {
                if (next !== hdxCity) {
                  track(EVENTS.SORT_CHANGE, { from: `city:${hdxCity || "all"}`, to: `city:${next || "all"}`, source: sourceType });
                  setHdxCity(next);
                }
              }}
              onWhenChange={(next) => {
                if (next !== hdxWhen) {
                  track(EVENTS.SORT_CHANGE, { from: `when:${hdxWhen || "all"}`, to: `when:${next || "all"}`, source: sourceType });
                  setHdxWhen(next);
                }
              }}
              onFormChange={(next) => {
                if (next !== hdxForm) {
                  track(EVENTS.SORT_CHANGE, { from: `form:${hdxForm || "all"}`, to: `form:${next || "all"}`, source: sourceType });
                  setHdxForm(next);
                }
              }}
            />
          )}
          {/* hf_paper 默认按时间倒序,不需要 sort toggle(PM v5 反馈)；
              官方新闻(blog,podcast)无互动数,时间倒序即可,同样不显示(§10.5) */}
          {!placeholder && !isClawhub && sourceType !== "github" && sourceType !== "product_hunt" && sourceType !== "huodongxing" && sourceType !== "hf_paper" && sourceType !== "blog,podcast" && (
            <SortSelector
              value={sortMode}
              onChange={(next) => {
                if (next !== sortMode) {
                  track(EVENTS.SORT_CHANGE, { from: sortMode, to: next, source: sourceType });
                }
                setSortMode(next);
              }}
            />
          )}
          <div className="text-[11px] text-neutral-500">
            {placeholder ? "规划中" : ""}
          </div>
        </div>
      </header>

      {/* New items banner — stacked avatars + count (Twitter-style)
          只有 X 列展示该 banner；其它源都不展示（review 反馈）：
          - PH 是日榜、huodongxing 活动批次性更新 — 没有持续流式语义
          - clawhub / github 也是离散更新（marketplace / trending），banner 噪声大于价值 */}
      {pending.length > 0 && !isPh && !isHdx && !isClawhub && !isGh && (
        <button
          type="button"
          onClick={() => {
            track(EVENTS.NEW_CONTENT_BANNER_CLICK, { count_pending: pending.length, source: sourceType });
            showPending();
          }}
          className="flex items-center justify-center gap-2 border-b border-neutral-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100"
        >
          <PendingAvatars pending={pending} />
          <span>↑ {pending.length} 条新推文</span>
        </button>
      )}

      {/* Body */}
      <div
        ref={feedBodyRef}
        className="feed-body relative md:flex-1 md:overflow-y-auto"
        style={{ overscrollBehavior: "contain", touchAction: "pan-y" }}
      >
        {!placeholder && (
          <div
            ref={pullIndicatorRef}
            className="motion-pull-indicator pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[46px] items-end justify-center pb-1.5 text-[11px] text-neutral-400"
            style={{
              opacity: 0,
              transform: `translateY(-${PULL_SLOT_HEIGHT}px)`,
            }}
          >
            <span
              className={cn(
                "inline-block mr-2",
                isRefreshingPull && "animate-spin",
              )}
            >⟳</span>
            <span ref={pullLabelRef}>下拉刷新</span>
          </div>
        )}
        {placeholder ? (
          <div className="flex min-h-[60vh] items-center justify-center text-sm text-neutral-400">
            暂无数据源
          </div>
        ) : error ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-sm">
            <div className="text-red-500">加载失败</div>
            <button
              type="button"
              onClick={() => setRetryTick((t) => t + 1)}
              className="rounded-md border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              重试
            </button>
          </div>
        ) : items.length === 0 && hasMore ? (
          <>
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </>
        ) : items.length === 0 ? (
          <div className="flex min-h-[60vh] items-center justify-center text-sm text-neutral-400">
            {isHdx && (hdxWhen || hdxCity || hdxForm)
              ? hdxWhen
                ? "该时段暂无活动"
                : hdxCity
                  ? `${hdxCity}暂无相关活动`
                  : "暂无相关活动"
              : isHot
                ? "热门内容已看完，试试时间倒序"
                : "暂无内容"}
          </div>
        ) : (
          <>
            {rows.flatMap((row, idx) => {
              const nodes = [];
              if (idx === waistbandIndex) {
                nodes.push(
                  <div
                    key="waistband"
                    className="flex items-center justify-center gap-1.5 border-b border-neutral-100 bg-neutral-50/40 px-4 py-2.5 text-[11px] text-neutral-400"
                  >
                    <svg
                      className="h-3 w-3"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                    <span>上次看到这里</span>
                  </div>,
                );
              }
              const mediaPolicy = getMediaLoadPolicy({
                columnIndex: mediaColumnIndex,
                rowIndex: idx,
                immediate: mediaColumnImmediate,
              });
              nodes.push(
                row.kind === "single" ? (
                  <ItemCard key={row.item.id} item={row.item} mediaPolicy={mediaPolicy} />
                ) : (
                  <ThreadCard
                    key={`thread-${row.rootId}`}
                    items={row.items}
                    mediaPolicy={mediaPolicy}
                  />
                ),
              );
              return nodes;
            })}
            {/* Infinite scroll sentinel — replaced by a manual retry button
                once we've hit the consecutive-failure threshold. WeChat
                WebView gives bursts of "Load failed" that stop the
                IntersectionObserver from being a useful auto-trigger
                (telemetry showed 30+ failures in 45s). */}
            {hasMore && loadMoreCoolingDown && (
              <div className="flex flex-col items-center gap-2 py-4 text-center text-xs">
                <span className="text-neutral-500">网络不稳定，加载失败</span>
                <button
                  type="button"
                  onClick={retryLoadMore}
                  className="rounded-md border border-neutral-200 bg-white px-3 py-1 text-neutral-700 hover:bg-neutral-50"
                >
                  重试
                </button>
              </div>
            )}
            {hasMore && !loadMoreCoolingDown && (
              <div
                ref={sentinelRef}
                className="py-4 text-center text-xs text-neutral-400"
              >
                {loadingMore ? "加载中…" : "\u00A0"}
              </div>
            )}
            {!hasMore && items.length > 0 && (
              <div className="py-4 text-center text-xs text-neutral-400">
                已到底
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </VideoColumnProvider>
  );
});

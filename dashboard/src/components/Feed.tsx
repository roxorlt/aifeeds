import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fetchItems } from "../api";
import type { Item, SourceType } from "../types";
import { TweetCard } from "./TweetCard";
import { ThreadCard } from "./ThreadCard";
import { SourceIcon } from "./icons";
import {
  groupByThread,
  getLastSeen,
  setLastSeen,
  rowMaxScrapedAt,
  getSeenIds,
  markSeen,
  parseJsonField,
  proxyImg,
  cn,
} from "../lib/utils";
import type { ItemExtra } from "../types";
import { scrollFeedOrPage, smoothScrollToTop } from "../lib/scroll";
import { SortSelector, type SortMode } from "./SortSelector";
import { useDrawer } from "../lib/drawer";

interface Props {
  sourceType: SourceType;
  title: string;
  placeholder?: boolean;
  refreshTick: number;
}

const INITIAL_LIMIT = 30;
const LOAD_MORE_LIMIT = 30;
const POLL_INTERVAL_MS = 30_000;
// After this long of page-visible time, commit current top item to localStorage
// as the new last-seen boundary. Next visit's waistband will sit just below it.
// Commit the current top item as "seen" after this much *visible* page time.
// Timer is paused while the tab is hidden — so if the user opens the tab but
// never looks at it, last-seen stays where it was.
const MARK_SEEN_DELAY_MS = 5_000;

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
          src={proxyImg(a.url)}
          alt={a.handle}
          className="h-5 w-5 rounded-full ring-2 ring-blue-50 object-cover"
          style={{ zIndex: avatars.length - i }}
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      ))}
    </div>
  );
}

function SkeletonCard() {
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
  scrollToTop: () => void;
}

export const Feed = forwardRef<FeedHandle, Props>(function Feed(
  { sourceType, title, placeholder, refreshTick },
  ref,
) {
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastScrapedAt = useRef<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>("hot");
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const feedBodyRef = useRef<HTMLDivElement | null>(null);
  const [pullY, setPullY] = useState(0);
  const [isRefreshingPull, setIsRefreshingPull] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const pullYRef = useRef(0);
  const loadingRef = useRef(false);
  const isDraggingRef = useRef(false);

  const isHot = sortMode === "hot";

  // Initial load + refresh on tick or sort change
  useEffect(() => {
    if (placeholder) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchItems({
      source_type: sourceType,
      limit: INITIAL_LIMIT,
      sort: isHot ? "hot" : undefined,
    })
      .then((res) => {
        if (cancelled) return;
        let itemsToShow = res.items;
        if (isHot) {
          // Filter out already-seen ids so pull-down surfaces unseen hottest.
          const seen = getSeenIds(sourceType);
          itemsToShow = res.items.filter((i) => !seen.has(i.id));
          markSeen(sourceType, itemsToShow.map((i) => i.id));
        }
        setItems(itemsToShow);
        setPending([]);
        setNextCursor(res.next_cursor);
        setHasMore(res.has_more);
        lastScrapedAt.current = res.items[0]?.scraped_at || null;
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sourceType, placeholder, refreshTick, retryTick, isHot]);

  const loadMore = useCallback(async () => {
    if (placeholder || loadingMore || !hasMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetchItems({
        source_type: sourceType,
        cursor: nextCursor,
        limit: LOAD_MORE_LIMIT,
        sort: isHot ? "hot" : undefined,
      });
      const seen = isHot ? getSeenIds(sourceType) : null;
      setItems((prev) => {
        const existing = new Set(prev.map((i) => i.id));
        const fresh = res.items.filter(
          (i) => !existing.has(i.id) && (!seen || !seen.has(i.id)),
        );
        if (isHot) markSeen(sourceType, fresh.map((i) => i.id));
        return [...prev, ...fresh];
      });
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch {
      // fail silently; next observer trigger or scroll will retry
    } finally {
      setLoadingMore(false);
    }
  }, [placeholder, loadingMore, hasMore, nextCursor, sourceType, isHot]);

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

  const PULL_THRESHOLD = 60;
  const PULL_RESISTANCE = 2.5;
  const PULL_MAX = 110;

  // Native touch listeners so we can preventDefault in touchmove — React attaches
  // its synthetic touchmove as a passive listener, so the browser's own pull-down
  // behavior wins and the finger never "drags" the feed.
  useEffect(() => {
    if (placeholder) return;
    // Only activate PRR on mobile — PC uses bounded cell scroll, no pull gesture
    if (!window.matchMedia("(max-width: 767px)").matches) return;

    const isAtTop = () => window.scrollY <= 0;

    const onStart = (e: TouchEvent) => {
      if (isAtTop()) {
        pullStartY.current = e.touches[0].clientY;
        isDraggingRef.current = false;
      } else {
        pullStartY.current = null;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pullStartY.current === null) return;
      if (!isAtTop()) {
        pullStartY.current = null;
        pullYRef.current = 0;
        isDraggingRef.current = false;
        setPullY(0);
        return;
      }
      const dy = e.touches[0].clientY - pullStartY.current;
      if (dy > 0) {
        if (e.cancelable) e.preventDefault();
        isDraggingRef.current = true;
        const next = Math.min(dy / PULL_RESISTANCE, PULL_MAX);
        pullYRef.current = next;
        setPullY(next);
      }
    };
    const onEnd = () => {
      const shouldRefresh =
        pullStartY.current !== null &&
        pullYRef.current > PULL_THRESHOLD &&
        !loadingRef.current;
      if (shouldRefresh) {
        setIsRefreshingPull(true);
        setRetryTick((t) => t + 1);
      }
      pullYRef.current = 0;
      isDraggingRef.current = false;
      setPullY(0);
      pullStartY.current = null;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [placeholder]);

  // Hot mode: if the initial fetch or a page-load returns items that all get
  // filtered out as "seen", items becomes empty but hasMore is still true.
  // Auto-chain into the next page so the user doesn't see a dead empty state.
  useEffect(() => {
    if (
      !placeholder &&
      isHot &&
      !loading &&
      !loadingMore &&
      hasMore &&
      nextCursor &&
      items.length === 0
    ) {
      loadMore();
    }
  }, [placeholder, isHot, loading, loadingMore, hasMore, nextCursor, items.length, loadMore]);

  // Polling for new items. In time mode we prepend to `pending` and let the
  // banner show "N 条新内容"; click prepends + scrolls to top. In hot mode the
  // sort is score-based, so newly-scraped items may not belong at the top —
  // we still count them, but clicking the banner triggers a full re-fetch with
  // fresh hot ranking instead of prepending stale positions.
  useEffect(() => {
    if (placeholder) return;
    const poll = async () => {
      if (!lastScrapedAt.current) return;
      try {
        const res = await fetchItems({
          source_type: sourceType,
          since: lastScrapedAt.current,
          limit: 50,
        });
        const existingIds = new Set([...items, ...pending].map((i) => i.id));
        const fresh = res.items.filter((i) => !existingIds.has(i.id));
        if (fresh.length > 0) {
          setPending((prev) => [...fresh, ...prev]);
          lastScrapedAt.current = fresh[0].scraped_at;
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
          const seen = getSeenIds(sourceType);
          const itemsToShow = res.items.filter((i) => !seen.has(i.id));
          markSeen(sourceType, itemsToShow.map((i) => i.id));
          setItems(itemsToShow);
          setPending([]);
          setNextCursor(res.next_cursor);
          setHasMore(res.has_more);
          if (res.items.length > 0) {
            lastScrapedAt.current = res.items[0].scraped_at;
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

  const { spotlightItem } = useDrawer();

  // Inject the spotlight tweet (from cold-link or in-app drawer open) at the
  // top of this column's data, so closing the drawer leaves the user able to
  // find it. Only applies to columns matching the spotlight's source_type;
  // skipped if it's already in the loaded feed.
  const itemsWithSpotlight = useMemo(() => {
    if (!spotlightItem) return items;
    if (spotlightItem.source_type !== sourceType) return items;
    if (items.find((i) => i.id === spotlightItem.id)) return items;
    return [spotlightItem, ...items];
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
    scrollToTop: () => smoothScrollToTop(feedBodyRef.current),
  }));

  return (
    <div className="flex flex-col overflow-hidden bg-white md:max-h-[70vh] md:rounded-lg md:border md:border-neutral-200 md:shadow-sm">
      {/* Header */}
      <header
        className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 md:cursor-pointer"
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
          {!placeholder && (
            <SortSelector value={sortMode} onChange={setSortMode} />
          )}
          <div className="text-[11px] text-neutral-500">
            {placeholder ? "规划中" : ""}
          </div>
        </div>
      </header>

      {/* New items banner — stacked avatars + count (Twitter-style) */}
      {pending.length > 0 && (
        <button
          type="button"
          onClick={showPending}
          className="flex items-center justify-center gap-2 border-b border-neutral-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100"
        >
          <PendingAvatars pending={pending} />
          <span>↑ {pending.length} 条新推文</span>
        </button>
      )}

      {/* Body */}
      <div
        ref={feedBodyRef}
        className="feed-body md:flex-1 md:overflow-y-auto"
        style={{ overscrollBehavior: "contain", touchAction: "pan-y" }}
      >
        {(pullY > 0 || isRefreshingPull) && !placeholder && (
          <div
            className="flex items-end justify-center overflow-hidden text-[11px] text-neutral-400"
            style={{
              height: isRefreshingPull ? PULL_THRESHOLD : pullY,
              paddingBottom: 6,
              transition: isDraggingRef.current
                ? "none"
                : "height 200ms ease-out",
            }}
          >
            <span
              className={cn(
                "inline-block mr-2",
                isRefreshingPull && "animate-spin",
              )}
            >⟳</span>
            <span>
              {isRefreshingPull
                ? "正在刷新"
                : pullY > PULL_THRESHOLD
                  ? "松手刷新"
                  : "下拉刷新"}
            </span>
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
            {isHot ? "热门内容已看完，试试时间倒序" : "暂无内容"}
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
              nodes.push(
                row.kind === "single" ? (
                  <TweetCard
                    key={row.item.id}
                    item={row.item}
                    hideThreadBanner
                  />
                ) : (
                  <ThreadCard key={`thread-${row.rootId}`} items={row.items} />
                ),
              );
              return nodes;
            })}
            {/* Infinite scroll sentinel */}
            {hasMore && (
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
  );
});

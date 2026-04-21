import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../lib/utils";

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

export function Feed({ sourceType, title, placeholder, refreshTick }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const lastScrapedAt = useRef<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Initial load + refresh on tick
  useEffect(() => {
    if (placeholder) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchItems({ source_type: sourceType, limit: INITIAL_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setPending([]);
        setNextCursor(res.next_cursor);
        setHasMore(res.has_more);
        setLastUpdated(res.items[0]?.scraped_at || null);
        lastScrapedAt.current = res.items[0]?.scraped_at || null;
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sourceType, placeholder, refreshTick, retryTick]);

  const loadMore = useCallback(async () => {
    if (placeholder || loadingMore || !hasMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetchItems({
        source_type: sourceType,
        cursor: nextCursor,
        limit: LOAD_MORE_LIMIT,
      });
      setItems((prev) => {
        const existing = new Set(prev.map((i) => i.id));
        const fresh = res.items.filter((i) => !existing.has(i.id));
        return [...prev, ...fresh];
      });
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch {
      // fail silently; next observer trigger or scroll will retry
    } finally {
      setLoadingMore(false);
    }
  }, [placeholder, loadingMore, hasMore, nextCursor, sourceType]);

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

  // Polling for new items
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
        // Filter out items we already have (the 'since' boundary may include the latest)
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
    setItems((prev) => [...pending, ...prev]);
    setPending([]);
    if (pending[0]) setLastUpdated(pending[0].scraped_at);
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
  useEffect(() => {
    if (placeholder || items.length === 0) return;
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
  }, [sourceType, placeholder, items]);

  const rows = useMemo(() => groupByThread(items), [items]);

  // Find the waistband insertion index: first row whose newest scraped_at is
  // <= initialLastSeen (i.e., the first "already seen" row). Returns -1 if
  // either everything is new (not loaded enough) or everything is seen.
  const waistbandIndex = useMemo(() => {
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
  }, [rows]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <SourceIcon
            source_type={sourceType}
            className="h-4 w-4 shrink-0 fill-current text-neutral-700"
          />
          <span className="truncate text-sm font-semibold text-neutral-900">
            {title}
          </span>
        </div>
        <div className="shrink-0 text-[11px] text-neutral-500">
          {placeholder ? "规划中" : loading && !lastUpdated ? "加载中" : ""}
        </div>
      </header>

      {/* New items banner */}
      {pending.length > 0 && (
        <button
          type="button"
          onClick={showPending}
          className="border-b border-neutral-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100"
        >
          ↑ {pending.length} 条新内容
        </button>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto feed-body">
        {placeholder ? (
          <div className="flex h-40 items-center justify-center text-sm text-neutral-400">
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
        ) : loading && items.length === 0 ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : items.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-neutral-400">
            暂无内容
          </div>
        ) : (
          <>
            {rows.flatMap((row, idx) => {
              const nodes = [];
              if (idx === waistbandIndex) {
                nodes.push(
                  <div
                    key="waistband"
                    className="flex items-center gap-2 border-y border-blue-200 bg-blue-50/60 px-3 py-1.5 text-[11px] font-medium text-blue-600"
                  >
                    <span className="h-px flex-1 bg-blue-200" />
                    上次看到这里
                    <span className="h-px flex-1 bg-blue-200" />
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
}

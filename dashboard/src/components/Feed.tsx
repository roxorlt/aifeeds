import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchItems } from "../api";
import type { Item, SourceType } from "../types";
import { TweetCard } from "./TweetCard";
import { ThreadCard } from "./ThreadCard";
import { SourceIcon } from "./icons";
import { groupByThread } from "../lib/utils";

interface Props {
  sourceType: SourceType;
  title: string;
  placeholder?: boolean;
  refreshTick: number;
}

const INITIAL_LIMIT = 30;
const LOAD_MORE_LIMIT = 30;
const POLL_INTERVAL_MS = 30_000;

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

  const rows = useMemo(() => groupByThread(items), [items]);

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
            {rows.map((row) =>
              row.kind === "single" ? (
                <TweetCard key={row.item.id} item={row.item} hideThreadBanner />
              ) : (
                <ThreadCard key={`thread-${row.rootId}`} items={row.items} />
              ),
            )}
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

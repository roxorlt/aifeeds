import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HomeFeedResponse, Item } from "../types";
import { getIntersectionRoot } from "../lib/scrollRoot";
import { fetchHomeFeedPage } from "./homeData";
import { WaterfallCard } from "./WaterfallCard";
import { getWaterfallCardModel } from "./waterfallCardModel";
import { rankWaterfallMedia } from "./waterfallMedia";

type Props = Readonly<{
  initialData: HomeFeedResponse;
}>;

declare global {
  interface Window {
    __aifeedsLayoutWaterfall?: () => void;
  }
}

function appendUnique(current: Item[], incoming: Item[]): Item[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

export function WaterfallHome({ initialData }: Props) {
  const gridRef = useRef<HTMLOListElement>(null);
  const paginationRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const [items, setItems] = useState(initialData.items);
  const [cursor, setCursor] = useState(initialData.next_cursor);
  const [hasMore, setHasMore] = useState(initialData.has_more);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const mediaRanks = useMemo(
    () => rankWaterfallMedia(
      items.map((item) => Boolean(getWaterfallCardModel(item).image)),
    ),
    [items],
  );

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return undefined;

    let measureFrame = 0;

    const scheduleReconcile = () => {
      window.cancelAnimationFrame(measureFrame);
      measureFrame = window.requestAnimationFrame(() => {
        window.__aifeedsLayoutWaterfall?.();
      });
    };

    window.__aifeedsLayoutWaterfall?.();
    const observer = new ResizeObserver(scheduleReconcile);
    grid.querySelectorAll<HTMLElement>(".waterfall-card").forEach((card) => {
      observer.observe(card);
    });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(measureFrame);
    };
  }, [items.length]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !cursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    try {
      const next = await fetchHomeFeedPage({ cursor, limit: 24 });
      setItems((current) => appendUnique(current, next.items));
      setCursor(next.next_cursor);
      setHasMore(next.has_more);
    } catch {
      setError(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor, hasMore]);

  useEffect(() => {
    if (!hasMore || !cursor) return undefined;
    if (error) return undefined;
    if (typeof IntersectionObserver === "undefined") return undefined;
    const pagination = paginationRef.current;
    if (!pagination) return undefined;

    const root = getIntersectionRoot();
    let observer: IntersectionObserver | null = null;

    const canAutoLoad = () => {
      if (document.visibilityState !== "visible") return false;
      if (navigator.onLine === false) return false;
      return true;
    };

    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && canAutoLoad()) {
          void loadMore();
        }
      },
      { root, rootMargin: "600px 0px" },
    );
    observer.observe(pagination);

    const recheck = () => {
      if (!observer || !canAutoLoad()) return;
      observer.unobserve(pagination);
      observer.observe(pagination);
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("online", recheck);

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("online", recheck);
    };
  }, [cursor, error, hasMore, loadMore]);

  return (
    <main id="content" className="waterfall-main">
      <ol ref={gridRef} className="waterfall-grid" aria-label="AI 动态瀑布流">
        {items.map((item, position) => (
          <WaterfallCard
            key={item.id}
            item={item}
            siblings={items}
            mediaRank={mediaRanks[position]}
          />
        ))}
      </ol>
      <div ref={paginationRef} className="waterfall-pagination">
        {hasMore && cursor ? (
          <button type="button" onClick={loadMore} disabled={loading}>
            {loading ? "正在加载…" : error ? "重试加载" : "加载更多"}
          </button>
        ) : (
          <p>已显示本期全部内容</p>
        )}
        <span role="status" aria-live="polite">
          {error ? "加载失败，请稍后重试。" : ""}
        </span>
      </div>
    </main>
  );
}

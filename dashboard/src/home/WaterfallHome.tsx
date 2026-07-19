import { useLayoutEffect, useRef, useState } from "react";
import type { HomeFeedResponse, Item } from "../types";
import { fetchHomeFeedPage } from "./homeData";
import { WaterfallCard } from "./WaterfallCard";

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
  const [items, setItems] = useState(initialData.items);
  const [cursor, setCursor] = useState(initialData.next_cursor);
  const [hasMore, setHasMore] = useState(initialData.has_more);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

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

  const loadMore = async () => {
    if (!hasMore || !cursor || loading) return;
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
      setLoading(false);
    }
  };

  return (
    <main id="content" className="waterfall-main">
      <ol ref={gridRef} className="waterfall-grid" aria-label="AI 动态瀑布流">
        {items.map((item, position) => (
          <WaterfallCard
            key={item.id}
            item={item}
            siblings={items}
            position={position}
          />
        ))}
      </ol>
      <div className="waterfall-pagination">
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

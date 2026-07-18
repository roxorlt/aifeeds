import { useState } from "react";
import type { HomeFeedResponse, Item } from "../types";
import { fetchHomeFeedPage } from "./homeData";
import { WaterfallCard } from "./WaterfallCard";

type Props = Readonly<{
  initialData: HomeFeedResponse;
}>;

function appendUnique(current: Item[], incoming: Item[]): Item[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

export function WaterfallHome({ initialData }: Props) {
  const [items, setItems] = useState(initialData.items);
  const [cursor, setCursor] = useState(initialData.next_cursor);
  const [hasMore, setHasMore] = useState(initialData.has_more);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

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
      <ol className="waterfall-grid" aria-label="AI 动态瀑布流">
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

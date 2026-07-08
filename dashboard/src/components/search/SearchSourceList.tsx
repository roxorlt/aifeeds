import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Item } from "../../types";
import { searchItems, classifySearchError, isRateLimited } from "../../api";
import { track, EVENTS } from "../../lib/telemetry";
import { toast } from "../../lib/toast";
import { SkeletonCard } from "../Feed";
import { ItemCard } from "../ItemCard";
import { SourceIcon } from "../icons";
import { browseSourceLabel } from "./sources";
import { HighlightProvider, extractHighlightTerms } from "./highlight";
import { trackResultClick } from "./searchResultShared";
import { SearchErrorBlock } from "./SearchGroups";

// 单源流（?q=&source=）：页头「在 {源} 中搜索『{q}』」+「搜全部」，IntersectionObserver
// 无限滚动（对照 Feed.tsx：rootMargin 200px、连败 3 次冷却 + 手动重试）。has_more=false
// 渲染「已到底」。q/source 变化用 useEffect 重置重拉（父级不 key 重建）；快速切换靠
// cancelled 丢弃过期首屏响应，loadMore 追加按 id 去重防重复 key。
interface SearchSourceListProps {
  q: string;
  source: string;
}

const FAIL_THRESHOLD = 3;

export default function SearchSourceList({ q, source }: SearchSourceListProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [errKind, setErrKind] = useState<string>("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const consecutiveFailRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const highlightTerms = useMemo(() => extractHighlightTerms(q), [q]);

  const searchAll = useCallback(
    () => navigate(`/search?q=${encodeURIComponent(q)}`),
    [navigate, q],
  );

  // 首屏 / q|source 变化重置重拉。
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setItems([]);
    setNextCursor(null);
    setHasMore(true);
    setCoolingDown(false);
    setErrKind("");
    consecutiveFailRef.current = 0;
    const startedAt = performance.now();
    searchItems(q, { source })
      .then((resp) => {
        if (cancelled) return;
        if (resp.mode !== "list") return; // 契约保证；防御性忽略非 list 响应
        track(EVENTS.SEARCH_PERF, {
          server_ms: resp.query_time_ms,
          client_ms: Math.round(performance.now() - startedAt),
          mode: "list",
        });
        if (resp.items.length === 0) {
          track(EVENTS.SEARCH_EMPTY, { q, mode: "list" });
          setHasMore(false);
          setStatus("empty");
          return;
        }
        setItems(resp.items);
        setNextCursor(resp.next_cursor);
        setHasMore(resp.has_more);
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        const kind = classifySearchError(err);
        track(EVENTS.SEARCH_ERROR, { kind, mode: "list" });
        if (isRateLimited(err)) toast.error("搜索太频繁，请稍后再试");
        setErrKind(kind);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [q, source, retryTick]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor || status !== "ready") return;
    if (consecutiveFailRef.current >= FAIL_THRESHOLD) return;
    setLoadingMore(true);
    try {
      const resp = await searchItems(q, { source, cursor: nextCursor });
      if (resp.mode !== "list") return;
      consecutiveFailRef.current = 0;
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...resp.items.filter((i) => !seen.has(i.id))];
      });
      setNextCursor(resp.next_cursor);
      setHasMore(resp.has_more);
    } catch (err) {
      consecutiveFailRef.current += 1;
      if (consecutiveFailRef.current >= FAIL_THRESHOLD) setCoolingDown(true);
      if (isRateLimited(err)) toast.error("搜索太频繁，请稍后再试");
      track(EVENTS.SEARCH_ERROR, {
        kind: classifySearchError(err),
        mode: "list",
        phase: "load_more",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, nextCursor, status, q, source]);

  const retryLoadMore = useCallback(() => {
    consecutiveFailRef.current = 0;
    setCoolingDown(false);
    void loadMore();
  }, [loadMore]);

  // 无限滚动 sentinel。SearchPage 是普通文档流（无内部滚动容器），root=null（viewport）。
  useEffect(() => {
    if (status !== "ready" || !hasMore || coolingDown) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [status, hasMore, coolingDown, loadMore]);

  const header = (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-sm text-neutral-700">
        <span className="shrink-0">在</span>
        <SourceIcon
          source_type={source}
          className="h-4 w-4 shrink-0 fill-current text-neutral-500"
        />
        <span className="shrink-0 font-medium">{browseSourceLabel(source)}</span>
        <span className="shrink-0">中搜索</span>
        <span className="truncate text-neutral-500">「{q}」</span>
      </div>
      {status !== "empty" && (
        <button
          type="button"
          onClick={searchAll}
          className="shrink-0 text-[13px] text-sky-600 transition-colors hover:text-sky-700"
        >
          搜全部
        </button>
      )}
    </div>
  );

  let body;
  if (status === "loading") {
    body = (
      <div>
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  } else if (status === "error") {
    body = <SearchErrorBlock kind={errKind} onRetry={() => setRetryTick((t) => t + 1)} />;
  } else if (status === "empty") {
    body = (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-neutral-700">没有找到与「{q}」相关的内容</p>
        <p className="text-[13px] text-neutral-500">换个关键词试试</p>
        <button
          type="button"
          onClick={searchAll}
          className="rounded-md border border-neutral-300 px-4 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          搜全部
        </button>
      </div>
    );
  } else {
    body = (
      <HighlightProvider terms={highlightTerms}>
      <div>
        {items.map((item, position) => (
          <div key={item.id} onClick={(e) => trackResultClick(e, item, position, null)}>
            <ItemCard item={item} />
          </div>
        ))}
        {hasMore && coolingDown && (
          <div className="flex flex-col items-center gap-2 py-4 text-center text-xs">
            <span className="text-neutral-500">网络不稳定，加载失败</span>
            <button
              type="button"
              onClick={retryLoadMore}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1 text-neutral-700 transition-colors hover:bg-neutral-50"
            >
              重试
            </button>
          </div>
        )}
        {hasMore && !coolingDown && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-neutral-400">
            {loadingMore ? "加载中…" : " "}
          </div>
        )}
        {!hasMore && items.length > 0 && (
          <div className="py-4 text-center text-xs text-neutral-400">已到底</div>
        )}
      </div>
      </HighlightProvider>
    );
  }

  return (
    <div data-search-state="list">
      {header}
      {body}
    </div>
  );
}

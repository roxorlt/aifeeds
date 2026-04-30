import { useEffect, useState } from "react";
import { Feed } from "./components/Feed";
import { TweetDrawer } from "./components/TweetDrawer";
import { DrawerProvider } from "./lib/drawer";
import { fetchSources, fetchStats } from "./api";
import type { Source, SourceType, Stats } from "./types";
import { cn, timeAgo } from "./lib/utils";
import { useIsNarrow } from "./lib/breakpoint";
import { scrollFeedOrPage } from "./lib/scroll";

interface SourceConfig {
  source_type: SourceType;
  title: string;
}

// Column layout — X is always first, then others. Placeholder sources
// show "暂无数据源" until their scrapers come online.
const SOURCE_COLUMNS: SourceConfig[] = [
  { source_type: "x_list", title: "X List" },
  { source_type: "youtube", title: "YouTube" },
  { source_type: "github", title: "GitHub" },
  { source_type: "podcast", title: "Podcast" },
  { source_type: "product_hunt", title: "Product Hunt" },
  { source_type: "arxiv", title: "arXiv" },
];

type FilterKey = "all" | SourceType;

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "x_list", label: "X" },
  { key: "youtube", label: "YouTube" },
  { key: "github", label: "GitHub" },
  { key: "podcast", label: "Podcast" },
  { key: "product_hunt", label: "PH" },
  { key: "arxiv", label: "arXiv" },
];

function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<FilterKey>(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
      ? "x_list"
      : "all",
  );
  const [refreshTick, setRefreshTick] = useState(0);

  const isNarrow = useIsNarrow();

  useEffect(() => {
    fetchSources().then(setSources).catch(() => {});
    fetchStats().then(setStats).catch(() => {});
  }, [refreshTick]);

  // When narrow, "all" is invalid — drop to x_list
  useEffect(() => {
    if (isNarrow && filter === "all") setFilter("x_list");
  }, [isNarrow, filter]);

  // Derive which source types have live data
  const liveSourceTypes = new Set(
    sources.map((s) => s.source_type).concat(
      // Also consider source_type present in stats
      stats ? (Object.keys(stats.by_source) as SourceType[]) : [],
    ),
  );

  const visibleColumns = SOURCE_COLUMNS.filter((col) => {
    if (filter === "all") return true;
    return col.source_type === filter;
  });

  const getTitleForColumn = (col: SourceConfig): string => {
    if (col.source_type === "x_list") {
      const xSource = sources.find((s) => s.source_type === "x_list");
      return xSource?.name || col.title;
    }
    return col.title;
  };

  return (
    <DrawerProvider>
    <div className="min-h-screen bg-neutral-50">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-6 sm:py-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-bold tracking-tight text-neutral-900 sm:text-xl">
              AI-Feeds
            </h1>
            {/* Subtitle slogan TBD; intentionally empty for now */}
          </div>

          {/* Filter chips — mobile only, excludes "全部" */}
          {isNarrow && (
            <nav className="chips-rail flex min-w-0 items-center gap-1 overflow-x-auto">
              {FILTER_CHIPS.filter((c) => c.key !== "all").map(({ key, label }) => {
                const isActive = filter === key;
                const hasData = liveSourceTypes.has(key as SourceType);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (isActive) {
                        // Tap active chip → scroll current Feed to top
                        scrollFeedOrPage(null);
                      } else {
                        setFilter(key);
                      }
                    }}
                    className={cn(
                      "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-600 hover:bg-neutral-100",
                      !hasData && !isActive && "opacity-40",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
          )}

          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="shrink-0 rounded-md border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
            title="刷新"
          >
            ⟳
          </button>
        </div>
      </header>

      {/* 3-column grid */}
      <main className="mx-auto max-w-[1400px] px-3 py-3 sm:px-6 sm:py-6">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {visibleColumns.map((col) => {
            const isPlaceholder = !liveSourceTypes.has(col.source_type);
            return (
              <Feed
                key={col.source_type}
                sourceType={col.source_type}
                title={getTitleForColumn(col)}
                placeholder={isPlaceholder}
                refreshTick={refreshTick}
              />
            );
          })}
        </div>

        {/* Stats footer */}
        {stats && (
          <footer className="mt-6 text-center text-xs text-neutral-400">
            共 {stats.relevant_items.toLocaleString()} 条 AI 相关内容 · 今日新增{" "}
            {stats.items_today} · 最后更新 {timeAgo(stats.last_updated)}
          </footer>
        )}
      </main>
      <TweetDrawer />
    </div>
    </DrawerProvider>
  );
}

export default App;

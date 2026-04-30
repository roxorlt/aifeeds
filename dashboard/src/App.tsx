import { useEffect, useRef, useState } from "react";
import { Feed, type FeedHandle } from "./components/Feed";
import { TweetDrawer } from "./components/TweetDrawer";
import { DrawerProvider } from "./lib/drawer";
import { fetchSources, fetchStats } from "./api";
import type { Source, SourceType, Stats } from "./types";
import { cn } from "./lib/utils";
import { useIsNarrow } from "./lib/breakpoint";
import { scrollFeedOrPage, smoothScrollWindowToTop } from "./lib/scroll";

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
  const [storedFilter, setFilter] = useState<FilterKey>("all");
  const [refreshTick, setRefreshTick] = useState(0);

  const isNarrow = useIsNarrow();
  const feedRefs = useRef<Map<string, FeedHandle | null>>(new Map());

  // Derived filter: PC always shows "all" (chips hidden); mobile coerces
  // "all" → "x_list" since the "all" chip isn't rendered on narrow.
  const filter: FilterKey = !isNarrow
    ? "all"
    : storedFilter === "all"
      ? "x_list"
      : storedFilter;

  useEffect(() => {
    fetchSources().then(setSources).catch(() => {});
    fetchStats().then(setStats).catch(() => {});
  }, [refreshTick]);

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

  async function onTopBarClick() {
    if (isNarrow) {
      return smoothScrollWindowToTop();
    }
    const pageAtTop = window.scrollY <= 1;
    if (!pageAtTop) {
      return smoothScrollWindowToTop();
    }
    // Already at page top → scroll all PC columns to top
    feedRefs.current.forEach((handle) => handle?.scrollToTop());
  }

  return (
    <DrawerProvider>
    <div className="min-h-screen bg-neutral-50">
      {/* Top bar */}
      <header
        className="sticky top-0 z-10 cursor-pointer border-b border-neutral-200 bg-white/80 backdrop-blur"
        onClick={(e) => {
          // Skip when click is on chips, refresh button, etc.
          if ((e.target as HTMLElement).closest("button")) return;
          if ((e.target as HTMLElement).closest("nav")) return;
          onTopBarClick();
        }}
      >
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-8 sm:py-3 lg:px-16">
          <div className="flex shrink-0 items-baseline gap-3">
            <h1 className="whitespace-nowrap text-lg font-bold tracking-tight text-neutral-900 sm:text-xl">
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
                      "shrink-0 min-w-[64px] rounded-full px-3 py-1 text-center text-xs font-medium transition-colors",
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
      <main className="mx-auto max-w-[1280px] px-3 py-3 sm:px-8 sm:py-6 lg:px-16">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {visibleColumns.map((col) => {
            const isPlaceholder = !liveSourceTypes.has(col.source_type);
            return (
              <Feed
                key={col.source_type}
                ref={(h) => {
                  if (h) feedRefs.current.set(col.source_type, h);
                  else feedRefs.current.delete(col.source_type);
                }}
                sourceType={col.source_type}
                title={getTitleForColumn(col)}
                placeholder={isPlaceholder}
                refreshTick={refreshTick}
              />
            );
          })}
        </div>

        <footer className="mt-6 text-center text-xs text-neutral-400">
          Built by{" "}
          <a
            href="https://blog.ai-feeds.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-600 hover:underline"
          >
            roxor
          </a>
          <span className="mx-1.5">·</span>
          <a
            href="https://github.com/roxorlt"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-600 hover:underline"
          >
            GitHub
          </a>
        </footer>
      </main>
      <TweetDrawer />
    </div>
    </DrawerProvider>
  );
}

export default App;

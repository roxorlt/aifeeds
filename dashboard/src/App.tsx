import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Feed, type FeedHandle } from "./components/Feed";
import { DrawerProvider } from "./lib/drawer";

// Drawer drags in react-markdown + remark-gfm + rehype-raw (~150kb gzipped).
// Defer it until first drawer open so initial paint isn't blocked by markdown
// deps the user may never need.
const TweetDrawer = lazy(() =>
  import("./components/TweetDrawer").then((m) => ({ default: m.TweetDrawer })),
);
import { fetchSources, fetchStats, TRACK_ENDPOINT } from "./api";
import type { Source, SourceType, Stats } from "./types";
import { cn } from "./lib/utils";
import { useIsNarrow } from "./lib/breakpoint";
import { scrollFeedOrPage, smoothScrollWindowToTop } from "./lib/scroll";
import { initTelemetry, track, EVENTS } from "./lib/telemetry";
import { installVitals } from "./lib/telemetry/vitals";
import { installErrorHandlers } from "./lib/telemetry/errors";
import { Routes, Route } from "react-router";
import { UserMenu } from "./components/UserMenu";
import { LoginModal } from "./components/LoginModal";
import { Toast } from "./components/Toast";
import { Settings } from "./pages/Settings";
import { AccountManage } from "./pages/AccountManage";
import { useAuthStore } from "./lib/authStore";

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

function DashboardHome() {
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [storedFilter, setFilter] = useState<FilterKey>("all");
  const [refreshTick, _setRefreshTick] = useState(0);

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

  // Block page-scroll initiation from non-scroll zones (top app bar,
  // feed column headers). iOS Safari / WeChat WebView ignores
  // `touch-action: pan-x` on most ancestor/descendant configurations
  // (WebKit bug 133112 / 233417), so we enforce it imperatively.
  //
  // Rules:
  //   - touch starts inside `.chips-rail` → allow horizontal motion,
  //     block vertical (after a small lock-direction threshold).
  //   - touch starts inside `[data-no-page-scroll]` (and not chips-rail)
  //     → block all motion (prevents page scroll initiation).
  //   - else → don't preventDefault, let the browser scroll normally.
  //
  // Direction-lock at 8px so a horizontal swipe with a tiny vertical
  // wobble doesn't get killed mid-gesture.
  useEffect(() => {
    if (!isNarrow) return;
    let target: Element | null = null;
    let startX = 0;
    let startY = 0;
    let direction: "h" | "v" | null = null;

    const onStart = (e: TouchEvent) => {
      target = e.target as Element | null;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      direction = null;
    };
    const onMove = (e: TouchEvent) => {
      if (!target) return;
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - startX);
      const dy = Math.abs(t.clientY - startY);
      if (direction === null && (dx > 8 || dy > 8)) {
        direction = dx > dy ? "h" : "v";
      }
      if (target.closest(".chips-rail")) {
        if (direction === "v" && e.cancelable) e.preventDefault();
        return;
      }
      if (target.closest("[data-no-page-scroll]")) {
        if (e.cancelable) e.preventDefault();
      }
    };
    const onEnd = () => {
      target = null;
      direction = null;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [isNarrow]);

  // Telemetry init（仅一次）
  useEffect(() => {
    initTelemetry({ endpoint: TRACK_ENDPOINT });
    installVitals();
    installErrorHandlers();
    track(EVENTS.APP_OPEN, {
      utm_source: new URLSearchParams(window.location.search).get('utm_source') || undefined,
      utm_campaign: new URLSearchParams(window.location.search).get('utm_campaign') || undefined,
      referrer: document.referrer || undefined,
    });
    track(EVENTS.PAGE_VIEW, {
      path: window.location.pathname + window.location.search,
    });
  }, []);

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
        {/* Bottom row of the app bar.
            `max-md:touch-pan-x` locks the *entire* mobile header to
            horizontal-only gestures. This is the only reliable way to
            stop iOS from splitting a near-horizontal swipe between the
            chips rail (pan-x) and the page (auto, vertical) when the
            finger lands in a sibling element or a flex gap. Per spec,
            touch-action on a child intersects with its ancestors, so
            we deliberately do NOT set pan-y on logo/refresh — that
            would intersect to "none" and block tap recognition timing
            on iOS. Vertical page scroll has to start from below the
            header, which is fine since the header is ~36px tall. */}
        <div
          data-no-page-scroll
          className="mx-auto flex max-w-[1280px] items-stretch justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-8 sm:py-3 lg:px-16 max-md:touch-pan-x"
        >
          <div className="flex shrink-0 items-center gap-2">
            <img
              src="/favicon.svg"
              alt="AI-Feeds"
              className="h-7 w-7 sm:h-8 sm:w-8"
              draggable={false}
            />
            <h1 className="whitespace-nowrap text-lg font-bold tracking-tight text-neutral-900 sm:text-xl">
              AI-Feeds
            </h1>
            {/* Subtitle slogan TBD; intentionally empty for now */}
          </div>

          {/* Filter chips — mobile only, excludes "全部".
              `self-stretch` makes the rail fill the header's full vertical
              padding so its `touch-action: pan-x` covers the entire row at
              the chips' x-range, not just the ~20px the chip buttons span.
              Without this, swipes 8px above/below the chip line fell
              through to the parent (touch-action: auto) and iOS picked the
              vertical axis, dragging the feed below. */}
          {isNarrow && (
            <nav className="chips-rail flex min-w-0 items-center gap-1 self-stretch overflow-x-auto">
              {FILTER_CHIPS.filter((c) => c.key !== "all").map(({ key, label }) => {
                const isActive = filter === key;
                const hasData = liveSourceTypes.has(key as SourceType);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (isActive) {
                        scrollFeedOrPage(null);
                      } else {
                        track(EVENTS.SOURCE_FILTER_CHANGE, { from_id: storedFilter, to_id: key });
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

          <UserMenu />
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
      <Suspense fallback={null}>
        <TweetDrawer />
      </Suspense>
    </div>
    </DrawerProvider>
  );
}

function App() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);

  // 启动时调 /api/auth/me hydrate
  useEffect(() => {
    if (!hydrated) {
      hydrate();
    }
  }, [hydrate, hydrated]);

  return (
    <>
      <Routes>
        <Route path="/" element={<DashboardHome />} />
        <Route path="/t/:id" element={<DashboardHome />} />
        <Route path="/g/:owner/:repo" element={<DashboardHome />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/account" element={<AccountManage />} />
      </Routes>
      <LoginModal />
      <Toast />
    </>
  );
}

export default App;

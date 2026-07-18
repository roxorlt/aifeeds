import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type UIEvent as ReactUIEvent,
} from "react";
import { Feed, SkeletonCard, prefetchChannel, type FeedHandle } from "./components/Feed";
import { SourceIcon, IconSearch } from "./components/icons";
import { DrawerProvider } from "./lib/drawer";

// Drawer drags in react-markdown + remark-gfm + rehype-raw (~150kb gzipped).
// Defer it until first drawer open so initial paint isn't blocked by markdown
// deps the user may never need.
const TweetDrawer = lazy(() =>
  import("./components/TweetDrawer").then((m) => ({ default: m.TweetDrawer })),
);

// PR3 quote 嵌套小卡点击 → 站内 modal。轻量(无 markdown 依赖),不 lazy
import { QuoteSnapshotModal } from "./components/QuoteSnapshotModal";

import { fetchFeedManifest } from "./api";
import { buildPublicWorkerUrl } from "./lib/apiBase";
import type { FeedManifest, SourceType } from "./types";
import { cn } from "./lib/utils";
import { useIsNarrow } from "./lib/breakpoint";
import { useVideoCoordinator, attachVisibilityListener } from "./lib/videoCoordinator";
import { attachVideoPrefsSync } from "./lib/videoPrefsSync";
import { useDrawer } from "./lib/drawerContext";
import { scrollFeedOrPage, smoothScrollWindowToTop } from "./lib/scroll";
import { resolveChannelSwipeIntent, watchTransformTransition } from "./lib/motion";
import { useReducedMotion } from "./lib/useReducedMotion";
import { addScrollRootListener, getScrollY } from "./lib/scrollRoot";
import { track, EVENTS } from "./lib/telemetry";
import {
  OPTIMISTIC_FEED_START,
  resolveChannelLive,
  type FeedMetadataState,
} from "./lib/feedAvailability";
import {
  adjacentSourceForIntent,
  canStartBackgroundPrefetch,
  createBackgroundQueue,
  createIntentPrefetchController,
  getImmediateColumnCount,
} from "./lib/feedScheduling";
import { Routes, Route, Navigate, useParams, useNavigate } from "react-router";
import { UserMenu } from "./components/UserMenu";
import { SubscribeBanner } from "./components/SubscribeBanner";
import { RequireAuth } from "./components/RequireAuth";
import { isWeChatBrowser } from "./lib/wechat";
// 路由专属页面 lazy 化：只在 /settings、/settings/account、/subscribe、
// /me/subscription 才需要，不该进首屏 bundle（Subscription 还拖 Turnstile）。
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const AccountManage = lazy(() => import("./pages/AccountManage").then((m) => ({ default: m.AccountManage })));
const Subscription = lazy(() => import("./pages/Subscription").then((m) => ({ default: m.Subscription })));
const Feedback = lazy(() => import("./pages/Feedback").then((m) => ({ default: m.Feedback })));
// C 端搜索页(公开,不包 RequireAuth)。三态骨架本任务建,内容 Task 10/11 填。
const SearchPage = lazy(() => import("./pages/SearchPage"));
import { useAuthStore } from "./lib/authStore";
import { useToastStore } from "./lib/toast";
import { HomeViewSwitch } from "./home/HomeViewSwitch";

// LoginModal 拖入 Turnstile 校验 + auth 表单逻辑。99% 已登录用户首屏永远
// 不会触发它 → lazy + Gate：loginModalOpen === false 时根本不挂 lazy 组件，
// chunk 完全不下载（lazy 不加 Gate 的话 React 会无脑触发 import）。
const LoginModal = lazy(() =>
  import("./components/LoginModal").then((m) => ({ default: m.LoginModal })),
);
function LoginModalGate() {
  const open = useAuthStore((s) => s.loginModalOpen);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LoginModal />
    </Suspense>
  );
}

// Toast 触发是事件驱动。首屏无 toast 时 chunk 不下载；首次 push 时短暂
// 延迟（chunk 下载时间）后显示，在 toast 场景可接受。
// 注：useToastStore (lib/toast.ts) 必须 eager — push() 触发时 store 得在内存。
const Toast = lazy(() =>
  import("./components/Toast").then((m) => ({ default: m.Toast })),
);
function ToastGate() {
  const hasItems = useToastStore((s) => s.items.length > 0);
  if (!hasItems) return null;
  return (
    <Suspense fallback={null}>
      <Toast />
    </Suspense>
  );
}

// TweetDrawer 拖 react-markdown + dompurify + qrcode + modern-screenshot + 5 个
// drawer body（~154kB gzip），首屏不该下载。Gate：抽屉没打开时不挂（chunk 不
// 下载），同时 idle 时悄悄预取，让首次点开依然秒开。冷链接 /t/:id 等首帧
// DrawerProvider 就把 state.item/loading 置上，need=true 立即挂载（不丢深链）。
function TweetDrawerGate() {
  const { state } = useDrawer();
  const need = Boolean(state.item) || state.loading || Boolean(state.error);
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const schedule = w.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = w.cancelIdleCallback ?? ((id: number) => window.clearTimeout(id));
    const id = schedule(() => {
      void import("./components/TweetDrawer");
    });
    return () => cancel(id);
  }, []);
  if (!need) return null;
  return (
    <Suspense fallback={null}>
      <TweetDrawer />
    </Suspense>
  );
}

// 顶栏搜索入口:放大镜按钮 → /search。样式对齐 UserMenu 未登录触发器(neutral 灰、
// hover 浅底、transition-colors)。shrink-0 保证移动端不被 chips rail 挤掉。
// 自带 useNavigate + track,不依赖 DashboardHome 作用域(同 Gate 组件惯例)。
function SearchEntryButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="搜索"
      onClick={() => {
        track(EVENTS.SEARCH_OPEN, { from: "appbar" });
        navigate("/search");
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-md text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
    >
      <IconSearch className="h-5 w-5" />
    </button>
  );
}

// 「官方新闻」合并频道（D7）：逗号拼 blog+podcast 的复合 filter 值。worker
// /api/items?source_type=blog,podcast 已支持；这是 FE 顶部入口专用的复合值，
// 不是单个 SourceType；fetchItems 的 buildItemsPath 会把它规范化为稳定路径。
type MergedSource = "blog,podcast";
const OFFICIAL_NEWS: MergedSource = "blog,podcast";

interface SourceConfig {
  source_type: SourceType | MergedSource;
  title: string;
}

function readCurrentConnection(): { saveData?: boolean; effectiveType?: string } | undefined {
  return (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
}

type DeferredFeedProps = {
  sourceType: SourceType | MergedSource;
  title: string;
  placeholder: boolean;
  refreshTick: number;
  onInitialRequestStart?: () => void;
  immediate: boolean;
  mediaColumnIndex: number;
  mediaColumnImmediate: boolean;
  observationEnabled: boolean;
};

// All below-fold reveals share one scheduler. A slot stays occupied until the
// mounted Feed's first authoritative read settles, so one intersection frame
// cannot fan out into several competing critical list requests.
const deferredFeedMountQueue = createBackgroundQueue();

// PC only mounts the responsive first row on the first commit. Lower rows keep a
// stable 70vh footprint but contain no Feed/media until the user has actually
// scrolled and the shell approaches the viewport. Once mounted, a column never
// unmounts; a wider resize may only promote more columns.
const DeferredFeed = forwardRef<FeedHandle, DeferredFeedProps>(function DeferredFeed(
  {
    immediate,
    mediaColumnIndex,
    mediaColumnImmediate,
    observationEnabled,
    sourceType,
    title,
    placeholder,
    refreshTick,
    onInitialRequestStart,
  },
  ref,
) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const settleDeferredMountRef = useRef<(() => void) | null>(null);
  const settleDeferredMount = useCallback(() => {
    settleDeferredMountRef.current?.();
  }, []);
  const [mounted, setMounted] = useState(
    () => immediate || typeof IntersectionObserver === "undefined",
  );

  useEffect(() => () => settleDeferredMount(), [settleDeferredMount]);

  useEffect(() => {
    if (mounted || immediate) return;
    // Correctness fallback comes before the scroll gate: the state initializer
    // already mounts every feed in old WebViews without IntersectionObserver.
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    if (!observationEnabled) return;
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void deferredFeedMountQueue.enqueue(() => new Promise<void>((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        let settled = false;
        const timeout = window.setTimeout(finish, 12_000);
        function finish() {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          if (settleDeferredMountRef.current === finish) {
            settleDeferredMountRef.current = null;
          }
          resolve();
        }
        settleDeferredMountRef.current = finish;
        setMounted(true);
      })).catch(() => {});
    }, {
      root: null,
      rootMargin: "200px 0px",
    });
    let disposed = false;
    observer.observe(shell);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [immediate, mounted, observationEnabled]);

  if (mounted || immediate) {
    return (
      <Feed
        ref={ref}
        sourceType={sourceType}
        title={title}
        placeholder={placeholder}
        refreshTick={refreshTick}
        onInitialRequestStart={onInitialRequestStart}
        onInitialRequestSettled={settleDeferredMount}
        mediaColumnIndex={mediaColumnIndex}
        mediaColumnImmediate={mediaColumnImmediate}
      />
    );
  }

  return (
    <div
      ref={shellRef}
      data-deferred-feed-shell={sourceType}
      className="h-[70vh] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm"
      aria-label={`${title}待加载`}
    >
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <SourceIcon
          source_type={sourceType as SourceType}
          className="h-4 w-4 shrink-0 fill-current text-neutral-400"
        />
        <span className="truncate text-sm font-semibold text-neutral-500">{title}</span>
      </div>
      <div className="space-y-4 p-4" aria-hidden>
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="space-y-2 border-b border-neutral-100 pb-4">
            <div className="h-3 w-1/3 rounded bg-neutral-100" />
            <div className="h-3 w-full rounded bg-neutral-100" />
            <div className="h-3 w-2/3 rounded bg-neutral-100" />
          </div>
        ))}
      </div>
    </div>
  );
});

// 抽屉打开 / 关闭时同步 VideoCoordinator 的 mode（feed ↔ drawer）。
// 必须在 DrawerProvider 内部渲染才能用 useDrawer。无 UI 输出。
function DrawerModeSync() {
  const drawerItem = useDrawer().state.item;
  useEffect(() => {
    useVideoCoordinator.getState().setMode(drawerItem ? "drawer" : "feed");
  }, [drawerItem]);
  return null;
}

// Column layout — X is always first, then others. Placeholder sources
// show "暂无数据源" until their scrapers come online.
// PM 2026-05-19:论文(hf_paper) 插到「开源项目 (github)」和「龙虾技能 (clawhub)」中间,
// 三者都是"工程产出/可读资产"类信息源,放一起方便用户横向浏览
// 2026-06-18 上线定序：x → 新闻&播客 → 热门产品 → 开源项目 → 论文 → 活动 → 龙虾技能。
// 「官方新闻」频道改名「新闻&播客」(blog+podcast 合并频道,filter 仍用逗号复合值
// `blog,podcast`,worker /api/items?source_type=blog,podcast 已支持,列内两源按
// published_at desc 混排,Feed.tsx 按 item.source_type 逐条路由卡片样式)。
const SOURCE_COLUMNS: SourceConfig[] = [
  { source_type: "x_list", title: "动态" },
  { source_type: OFFICIAL_NEWS, title: "新闻&播客" },
  { source_type: "product_hunt", title: "热门产品" },
  { source_type: "github", title: "开源项目" },
  // 2026-05-18：原 arxiv 列重命名为「论文」，source_type 切换到 hf_paper。
  // arxiv source_type 保留在 types.ts 备用（未来如接入非 HF arxiv 源可再加回 COLUMNS）。
  { source_type: "hf_paper", title: "论文" },
  { source_type: "huodongxing", title: "活动" },
  { source_type: "clawhub", title: "龙虾技能" },
  { source_type: "youtube", title: "YouTube" },
];

type FilterKey = "all" | SourceType | MergedSource;
const PILL_H = 26;

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  // 顺序必须与 SOURCE_COLUMNS 完全一致（错位会让 PC 列序与 mobile tab 序对不上 +
  // 墨汁动效错位）。2026-06-18 上线定序 + 「官方新闻」改名「新闻&播客」。
  { key: "x_list", label: "动态" },
  { key: OFFICIAL_NEWS, label: "新闻&播客" },
  { key: "product_hunt", label: "热门产品" },
  { key: "github", label: "开源项目" },
  { key: "hf_paper", label: "论文" },
  { key: "huodongxing", label: "活动" },
  { key: "clawhub", label: "龙虾技能" },
  { key: "youtube", label: "YouTube" },
];
const INTENT_SOURCE_ORDER = SOURCE_COLUMNS.map((column) => column.source_type);

// R22: skeleton + channel header 复用组件. swipe adjacent + chip overlay 都用,
// 跟 Feed mount 后的 header (SourceIcon + label + border-b bg-neutral-50)
// + 8 SkeletonCard 完全一致, 切换瞬间不"跳一下".
function ChannelSkeletonPanel({ filterKey }: { filterKey: string }) {
  const chip = FILTER_CHIPS.find((c) => c.key === filterKey);
  const label = chip?.label ?? filterKey;
  return (
    <div className="mx-auto h-full max-w-[1280px] overflow-hidden px-3 py-3">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <SourceIcon
          source_type={filterKey as SourceType}
          className="h-4 w-4 shrink-0 fill-current text-neutral-700"
        />
        <span className="truncate text-sm font-semibold text-neutral-900">{label}</span>
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

function DashboardHome() {
  const [manifest, setManifest] = useState<FeedManifest | null>(null);
  const [metadataState, setMetadataState] = useState<FeedMetadataState>("pending");
  // 反馈 #7：冷启动落在 deep link 上时，初始 filter 跟着对应 tab，避免关掉
  // drawer 后用户看到 X 流（mobile 默认）以为没回到 GH/PH。
  // 仅初次构造时读 pathname；后续用户切 tab / 直接打 / 都正常工作。
  const initialFilter: FilterKey = (() => {
    const p = typeof window !== "undefined" ? window.location.pathname : "/";
    if (p.startsWith("/g/")) return "github";
    if (p.startsWith("/ph/")) return "product_hunt";
    if (p.startsWith("/c/")) return "clawhub";
    if (p.startsWith("/e/")) return "huodongxing";
    if (p.startsWith("/t/")) return "x_list";
    // /o/ → 官方新闻（blog + podcast 合并频道）。/h/ 已被 hf_paper 占用。
    if (p.startsWith("/o/")) return OFFICIAL_NEWS;
    return "all";
  })();
  const [storedFilter, setFilter] = useState<FilterKey>(initialFilter);
  const [refreshTick] = useState(0);
  const [feedRequestStartedForTick, setFeedRequestStartedForTick] = useState<number | null>(null);
  const handleInitialFeedRequestStart = useCallback(() => {
    setFeedRequestStartedForTick((startedTick) => (
      startedTick === refreshTick ? startedTick : refreshTick
    ));
  }, [refreshTick]);
  const shouldLoadManifest = OPTIMISTIC_FEED_START
    && feedRequestStartedForTick === refreshTick;

  const isNarrow = useIsNarrow();
  const reduceMotion = useReducedMotion();
  const [immediateColumnCount, setImmediateColumnCount] = useState(() => (
    typeof window === "undefined" ? 1 : getImmediateColumnCount(window.innerWidth)
  ));
  const [pageHasScrolled, setPageHasScrolled] = useState(() => (
    typeof window !== "undefined" && (window.scrollY > 0 || getScrollY() > 0)
  ));
  const feedRefs = useRef<Map<string, FeedHandle | null>>(new Map());
  const lastInteractedColumnRef = useRef<string | null>(null);
  // PM 2026-05-19:选中 tab 自动 scrollIntoView 居中 — chip rail 横向滚动容器,
  // filter 切到非可视 chip 时把它居中到 rail 中部,让用户知道这是 active(避免
  // 切了但用户看不到激活状态以为没动)。useEffect 跑在 filter 声明之后(挪到 L155+)
  const chipRailRef = useRef<HTMLElement | null>(null);
  // PM 2026-05-27: chip-rail 内层 scroll content wrapper — ink-layer + chips 都在
  // 这个 inline-flex 内, nav 自己 overflow-x-auto 自动 scroll 整个 wrapper, ink-layer
  // 跟 chip 共享同一 offsetParent → 完全不需要 JS 同步 scrollLeft
  const chipScrollContentRef = useRef<HTMLDivElement | null>(null);
  // 单一 active pill：点击时只做 transform 过渡，横滑时直接跟手。
  // 宽度在目标变更时即时同步，不参与 transition，避免逐帧 layout。
  const pillARef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // PM 2026-05-20:#5 横划切 tab — feed 区域 main 上挂 touch listener,
  // 识别 horizontal-dominant swipe 切上/下一个 filter chip
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const update = () => setImmediateColumnCount((current) => (
      Math.max(current, getImmediateColumnCount(window.innerWidth))
    ));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (pageHasScrolled) return;
    const unlockAfterRealScroll = () => {
      if (window.scrollY > 0 || getScrollY() > 0) setPageHasScrolled(true);
    };
    // History/BFCache restoration may happen just after the first render.
    unlockAfterRealScroll();
    const frame = window.requestAnimationFrame(unlockAfterRealScroll);
    const removeScroll = addScrollRootListener(unlockAfterRealScroll);
    window.addEventListener("pageshow", unlockAfterRealScroll);
    return () => {
      window.cancelAnimationFrame(frame);
      removeScroll();
      window.removeEventListener("pageshow", unlockAfterRealScroll);
    };
  }, [isNarrow, pageHasScrolled]);

  const unlockDeferredFeedsFromColumnScroll = useCallback((event: ReactUIEvent<HTMLElement>) => {
    if (pageHasScrolled) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.classList.contains("feed-body") &&
      target.scrollTop > 0
    ) {
      setPageHasScrolled(true);
    }
  }, [pageHasScrolled]);

  // Derived filter: PC always shows "all" (chips hidden); mobile coerces
  // "all" → "x_list" since the "all" chip isn't rendered on narrow.
  const filter: FilterKey = !isNarrow
    ? "all"
    : storedFilter === "all"
      ? "x_list"
      : storedFilter;
  const liveSourceTypes = new Set(manifest?.live_source_types ?? []);
  const isChannelLive = (sourceType: string): boolean => resolveChannelLive(sourceType, {
    enabled: OPTIMISTIC_FEED_START,
    metadataState,
    live: liveSourceTypes,
  });
  const liveIntentSources = SOURCE_COLUMNS
    .filter((column) => isChannelLive(column.source_type))
    .map((column) => column.source_type);
  const liveIntentSourcesRef = useRef<readonly string[]>(liveIntentSources);
  liveIntentSourcesRef.current = liveIntentSources;
  const intentPrefetchControllerRef = useRef<ReturnType<typeof createIntentPrefetchController> | null>(null);
  if (!intentPrefetchControllerRef.current) {
    intentPrefetchControllerRef.current = createIntentPrefetchController();
  }
  useEffect(() => () => intentPrefetchControllerRef.current?.cancel(), []);
  const requestIntentPrefetch = useCallback((sourceType: string) => {
    if (
      !isNarrow
      || sourceType === filterRef.current
      || !liveIntentSourcesRef.current.includes(sourceType)
      || !canStartBackgroundPrefetch(readCurrentConnection)
    ) return;
    intentPrefetchControllerRef.current?.request(sourceType, async (target) => {
      if (
        !liveIntentSourcesRef.current.includes(target)
        || !canStartBackgroundPrefetch(readCurrentConnection)
      ) return;
      await prefetchChannel(target as SourceType | MergedSource);
    });
  }, [isNarrow]);
  const requestAdjacentIntentPrefetch = useCallback((
    direction: "previous" | "next",
  ) => {
    const target = adjacentSourceForIntent(
      filterRef.current,
      direction,
      INTENT_SOURCE_ORDER,
    );
    if (target) requestIntentPrefetch(target);
  }, [requestIntentPrefetch]);

  useEffect(() => {
    if (!shouldLoadManifest) return;
    const controller = new AbortController();
    setMetadataState("pending");
    void fetchFeedManifest(controller.signal)
      .then((nextManifest) => {
        if (controller.signal.aborted) return;
        setManifest(nextManifest);
        setMetadataState("resolved");
      })
      .catch(() => {
        if (!controller.signal.aborted) setMetadataState("failed");
      });
    return () => controller.abort();
  }, [refreshTick, shouldLoadManifest]);

  // 点击只移动单一 pill；width 在切换时即时更新，不进入 transition。
  const resetInkToActive = useCallback((key: string, withTransition: boolean) => {
    const pillA = pillARef.current;
    const chip = chipRefs.current[key];
    if (!pillA || !chip) return;
    delete pillA.dataset.swipeFrom;
    pillA.style.transition = "none";
    pillA.style.width = `${chip.offsetWidth}px`;
    pillA.style.height = `${PILL_H}px`;
    pillA.style.transformOrigin = "left center";
    pillA.style.transition = withTransition
      ? "transform 160ms cubic-bezier(0.23, 1, 0.32, 1)"
      : "none";
    pillA.style.transform = `translateX(${chip.offsetLeft}px) translateY(-50%)`;
  }, []);

  const renderInkBetween = useCallback((fromKey: string, toKey: string, progress: number) => {
    const pillA = pillARef.current;
    const fromChip = chipRefs.current[fromKey];
    const toChip = chipRefs.current[toKey];
    if (!pillA || !fromChip || !toChip) return;
    const fromRect = { left: fromChip.offsetLeft, width: fromChip.offsetWidth };
    const toRect = { left: toChip.offsetLeft, width: toChip.offsetWidth };
    const p = Math.max(0, Math.min(1, progress));
    const left = fromRect.left + (toRect.left - fromRect.left) * p;
    const visualWidth = fromRect.width + (toRect.width - fromRect.width) * p;
    if (pillA.dataset.swipeFrom !== fromKey) {
      pillA.dataset.swipeFrom = fromKey;
      pillA.style.width = `${fromRect.width}px`;
      pillA.style.height = `${PILL_H}px`;
      pillA.style.transformOrigin = "left center";
    }
    pillA.style.transition = "none";
    pillA.style.transform = `translateX(${left}px) translateY(-50%) scaleX(${visualWidth / fromRect.width})`;
  }, []);

  // PM 2026-05-19:active chip 自动 scrollIntoView 居中(声明位置必须在
  // `filter` derived state 之后,否则 TS 报 used-before-declaration)
  useEffect(() => {
    if (!isNarrow || !chipRailRef.current) return;
    const raf = requestAnimationFrame(() => {
      const chip = chipRailRef.current?.querySelector<HTMLButtonElement>(
        `[data-chip-key="${filter}"]`,
      );
      chip?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "nearest",
        inline: "center",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [filter, isNarrow, reduceMotion]);

  // PM 2026-05-27 v5: filter 切换后 pillA slide 到新 active chip + 重置 pillB/bridge.
  // - chip click 走 switchChannel → setFilter → 此 effect → pillA transition slide 过去;
  // - swipe end (touchend onTransitionEnd) 已手动 reset, 此 effect 跑只是同步同状态;
  // - first mount 不跑 transition (避免 pillA 从 (0,0) "滑入" active chip 首屏怪异).
  const isFirstPillSyncRef = useRef(true);
  useEffect(() => {
    if (!isNarrow) return;
    const raf = requestAnimationFrame(() => {
      resetInkToActive(
        filter,
        !isFirstPillSyncRef.current && !reduceMotion,
      );
      isFirstPillSyncRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [filter, isNarrow, reduceMotion, resetInkToActive]);

  // 横滑时只挂相邻 panel；top 在开始横滑时由当前 Header 可见比例确定，
  // 避免 Header 已隐藏时被强制弹回或留下 49px 空白。
  const [swipeAdjacent, setSwipeAdjacent] = useState<{ side: "left" | "right"; key: string; top: number } | null>(null);
  const adjacentRef = useRef<HTMLDivElement>(null);
  // PM 2026-05-27 任务 3: mobile 上推 feed 时 header 渐隐, 下拉时渐显 (iOS Safari /
  // Twitter mobile 同款). PC 不动 (header 永远显示).
  // PM 2026-05-27 v2 反馈: 不要 threshold + transition 二值切换 (看着像"突然"),
  // 改 1:1 跟手 progress-based — 手指刚动 1px header 就移动 1/49, opacity 连续渐变,
  // "渐变"在手势刚开始就启动.
  const headerRef = useRef<HTMLElement>(null);
  const hideRatioRef = useRef(0);
  useEffect(() => {
    const apply = (ratio: number) => {
      const h = headerRef.current;
      if (!h) return;
      h.style.transform = `translateY(${-ratio * 100}%)`;
      h.style.opacity = `${1 - ratio}`;
    };
    if (!isNarrow || reduceMotion) {
      hideRatioRef.current = 0;
      apply(0);
      return;
    }
    const TOP_ZONE = 50;
    const HEADER_H = 49;
    let scrollRaf: number | null = null;
    let lastY = getScrollY();
    const handler = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        const y = getScrollY();
        const delta = y - lastY;
        lastY = y;
        let next: number;
        if (y < TOP_ZONE) {
          next = 0;
        } else {
          next = Math.max(0, Math.min(1, hideRatioRef.current + delta / HEADER_H));
        }
        if (next !== hideRatioRef.current) {
          hideRatioRef.current = next;
          apply(next);
        }
      });
    };
    const removeScrollListener = addScrollRootListener(handler);
    return () => {
      removeScrollListener();
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      scrollRaf = null;
      hideRatioRef.current = 0;
      apply(0);
    };
  }, [isNarrow, reduceMotion]);
  const switchChannel = useCallback((nextFilter: string) => {
    if (nextFilter === filterRef.current) return;
    setFilter(nextFilter as typeof filter);
  }, []);
  const switchChannelRef = useRef(switchChannel);
  switchChannelRef.current = switchChannel;

  // PM 2026-05-20 #5: feed 区域横划切 tab(mobile only)。
  // 排除区域:drawer panel(swipe close 优先)/ chips-rail(已 pan-x) /
  // video 元素(组件内手势优先)/ data-no-swipe-tab 自定义 opt-out /
  // iOS 左 24px edge(系统 back gesture)。
  //
  // PM 2026-05-25 R8 跟手感:之前 touchend 时硬切 filter 无视觉过渡.
  // 现在 touchmove 阶段同步 main translateX 跟手指 (边界 tab 阻尼 1/3 反弹),
  // touchend 时若满足切换条件,先 animate slide-off → setFilter → reset.
  // 直接操作 DOM (而非 React state) 避开 60fps re-render 掉帧.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    if (!isNarrow) return;
    const el = mainRef.current;
    if (!el) return;

    let startX = 0, startY = 0, startT = 0;
    let active = false;
    let activeTouchId: number | null = null;
    let direction: 'unknown' | 'horizontal' | 'vertical' = 'unknown';
    let currentSide: 'left' | 'right' | null = null;
    let disposePendingSettle: (() => void) | null = null;
    let postSwitchRaf = 0;
    // R22: 删 lockBody/unlockBody. 架构改造后 PTR 不存在 (body 永久 fixed),
    // 不需要 swipe 期间额外 lock #root (反而拦了 vertical scroll, PM 反馈
    // "竖直方向无法上划"). horizontal swipe 期间 #root vertical scroll 跟
    // 横滑同时跑视觉上不明显, JS translate main 是主导.

    const applyMainTransform = (dx: number, withTransition: boolean) => {
      el.style.transition = withTransition
        ? 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)'
        : 'none';
      el.style.transform = dx === 0 ? '' : `translateX(${dx}px)`;
    };
    const applyAdjacentTransform = (dx: number, withTransition: boolean) => {
      const adj = adjacentRef.current;
      if (!adj) return;
      const w = window.innerWidth;
      // adjacent base 位置: side='right' 初始在屏右 (+w), side='left' 在屏左 (-w)
      // 跟 main 同 dx 同步移动 → main 滑出去时 adjacent 滑进来, 紧贴
      const base = currentSide === 'right' ? w : -w;
      adj.style.transition = withTransition
        ? 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)'
        : 'none';
      adj.style.transform = `translateX(${base + dx}px)`;
    };
    const resetTransform = () => {
      el.style.transition = '';
      el.style.transform = '';
      const adj = adjacentRef.current;
      if (adj) {
        adj.style.transition = '';
        adj.style.transform = '';
      }
    };
    const cleanupAdjacent = () => {
      currentSide = null;
      setSwipeAdjacent(null);
    };
    const cancelPendingSettle = () => {
      disposePendingSettle?.();
      disposePendingSettle = null;
      if (postSwitchRaf) cancelAnimationFrame(postSwitchRaf);
      postSwitchRaf = 0;
    };
    const settleTransform = (onComplete: () => void) => {
      cancelPendingSettle();
      disposePendingSettle = watchTransformTransition(el, {
        fallbackMs: 260,
        onComplete: () => {
          disposePendingSettle = null;
          onComplete();
        },
        onCancel: () => {
          disposePendingSettle = null;
          resetTransform();
          cleanupAdjacent();
        },
      });
    };
    const findActiveTouch = (touches: TouchList) => (
      activeTouchId === null
        ? undefined
        : Array.from(touches).find((touch) => touch.identifier === activeTouchId)
    );
    const cancelSwipeGesture = () => {
      cancelPendingSettle();
      resetTransform();
      if (direction === 'horizontal') {
        resetInkToActive(filterRef.current, false);
      }
      active = false;
      activeTouchId = null;
      direction = 'unknown';
      cleanupAdjacent();
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        cancelSwipeGesture();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-drawer-panel]')) return;
      if (target.closest('.chips-rail')) return;
      if (target.closest('video')) return;
      if (target.closest('[data-no-swipe-tab]')) return;
      const t0 = e.touches[0];
      if (t0.clientX < 24) return;
      cancelPendingSettle();
      resetTransform();
      cleanupAdjacent();
      startX = t0.clientX;
      startY = t0.clientY;
      startT = Date.now();
      activeTouchId = t0.identifier;
      direction = 'unknown';
      currentSide = null;
      active = true;
      // R22: 架构改造后 body 永久 fixed, PTR 根本不存在, touchstart 不需要
      // 任何 lockBody. lockBody 移到 onMove direction lock horizontal 时调,
      // 不影响 vertical scroll (R21 之前 touchstart lock 让 vertical 也被锁,
      // 导致 PM 反馈"竖直方向无法上划")
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      if (e.touches.length !== 1) {
        cancelSwipeGesture();
        return;
      }
      const t = findActiveTouch(e.touches);
      if (!t) {
        cancelSwipeGesture();
        return;
      }
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // R23 (2026-05-28): 删掉方向锁定前的首帧 preventDefault.
      // 它是 R17 为防"斜滑触发系统下拉刷新"加的, 但 R22 把 mobile body 改成
      // 永久 fixed (index.css max-md:overflow:hidden) 之后 pull-to-refresh 物理上
      // 已不存在 —— R22 删了配套的 onStart lockBody, 却漏删了这里的 preventDefault.
      // 残留的它反而拦了慢速纵滑的头几帧:iOS Safari 一旦
      // 在手势早期帧收到 preventDefault, 就判定该手势被 JS 接管, 即便后续锁定为
      // vertical 也不再启动 native scroll → 表现为"滑动偶尔不响应, 要反复多次才滚".
      // resolveChannelSwipeIntent 会等到横向意图明显强于纵向才接管；持续模糊的
      // 对角线最终按纵滑处理。横滑锁定后下方仍 preventDefault 跟手.
      if (direction === 'unknown') {
        const intent = resolveChannelSwipeIntent(dx, dy);
        if (intent === 'unknown') return;
        if (intent === 'vertical') {
          direction = 'vertical';
          active = false;
          activeTouchId = null;
          // R22: vertical lock, JS 不动 main, #root native scroll 接管
          return;
        }
        direction = 'horizontal';
      }
      if (direction === 'horizontal') {
        // R22: 架构改造后 PTR 不存在 (body 永久 fixed), 不再需要 preventDefault
        // + lockBody hack (它们反而拦了 #root native vertical scroll, 导致 PM
        // 反馈竖直方向上划失效). horizontal 锁定后只跟手 translate 即可.
        if (e.cancelable) e.preventDefault();
        requestAdjacentIntentPrefetch(dx < 0 ? "next" : "previous");
        if (reduceMotion) return;
        const tabs = FILTER_CHIPS.filter((c) => c.key !== 'all');
        const idx = tabs.findIndex((c) => c.key === filterRef.current);
        const targetIdx = dx < 0 ? idx + 1 : idx - 1;
        const atBoundary = targetIdx < 0 || targetIdx >= tabs.length;
        // mount adjacent panel (一次) — side 由 dx 方向定, key 是目标 channel
        if (!atBoundary) {
          const newSide: 'left' | 'right' = dx < 0 ? 'right' : 'left';
          if (currentSide !== newSide) {
            currentSide = newSide;
            setSwipeAdjacent({
              side: newSide,
              key: tabs[targetIdx].key,
              top: Math.round((1 - hideRatioRef.current) * 49),
            });
          }
        }
        // main 跟手 translate (边界 tab 阻尼 1/3)
        const dampened = atBoundary ? dx / 3 : dx;
        applyMainTransform(dampened, false);
        if (!atBoundary) applyAdjacentTransform(dampened, false);
        // 单一 pill 跟随横滑，仅写 transform。
        if (!atBoundary) {
          const w = window.innerWidth;
          const progress = Math.min(Math.abs(dx) / w, 1);
          renderInkBetween(filterRef.current, tabs[targetIdx].key, progress);
        }
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (!active || direction !== 'horizontal') {
        cancelSwipeGesture();
        return;
      }
      if (e.touches.length !== 0) {
        cancelSwipeGesture();
        return;
      }
      const t = findActiveTouch(e.changedTouches);
      if (!t) {
        cancelSwipeGesture();
        return;
      }
      active = false;
      activeTouchId = null;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Date.now() - startT;
      const tabs = FILTER_CHIPS.filter((c) => c.key !== 'all');
      const cur = filterRef.current;
      const idx = tabs.findIndex((c) => c.key === cur);

      // R16 切换阈值放宽 (PM 反馈"非常非常快才触发"):
      // - distance: viewport 15% (414 屏 = ~62px) 即切, 跟 iOS Music / Twitter 主流
      //   slide-to-switch 一致
      // - flick: v > 0.2 px/ms 且 |dx| > viewport 5% (~20px) — 短而快也切
      // - 移除 dt ≤ 800 限制 (慢滑只要距离够也切)
      const w = el.offsetWidth || window.innerWidth;
      const v = Math.abs(dx) / Math.max(dt, 1);
      const distanceOk = Math.abs(dx) >= w * 0.15;
      const flickOk = v > 0.2 && Math.abs(dx) >= w * 0.05;
      const shouldSwitch = (distanceOk || flickOk) && idx >= 0;
      void dy; void dt; // direction 已锁 horizontal, 不再叠加 dy / dt 过滤
      const nextIdx = !shouldSwitch ? idx : (dx < 0
        ? Math.min(idx + 1, tabs.length - 1)
        : Math.max(idx - 1, 0));

      if (reduceMotion) {
        resetTransform();
        cleanupAdjacent();
        if (shouldSwitch && nextIdx !== idx) {
          const nextKey = tabs[nextIdx].key;
          track(EVENTS.SOURCE_FILTER_CHANGE, {
            from_id: cur,
            to_id: nextKey,
            method: 'swipe',
          });
          switchChannelRef.current(nextKey);
          resetInkToActive(nextKey, false);
        } else {
          resetInkToActive(cur, false);
        }
        return;
      }

      if (!shouldSwitch || nextIdx === idx) {
        // 弹回 0 — main + adjacent 同步 animate 回原位
        applyMainTransform(0, true);
        applyAdjacentTransform(0, true);
        // 墨汁动效回弹到 from-chip baseline (transition 220ms)
        resetInkToActive(cur, true);
        settleTransform(() => {
          resetTransform();
          cleanupAdjacent();
        });
        return;
      }
      // animate 切换: main 滑到 ±width, adjacent 滑到 0 (屏内中央, 跟手紧贴)
      const width = el.offsetWidth || window.innerWidth;
      const mainTarget = dx < 0 ? -width : width;
      // adjacent target dx 同样 ±width, 加 base 后到 0
      applyMainTransform(mainTarget, true);
      applyAdjacentTransform(mainTarget, true);
      // 墨汁动效落到 to-chip baseline (跟 main 同 220ms 节奏 — useEffect [filter]
      // 也会 setFilter 后跑一次, 但状态已 reset 同位置, 重复 set 无视觉变化)
      resetInkToActive(tabs[nextIdx].key, true);
      settleTransform(() => {
        track(EVENTS.SOURCE_FILTER_CHANGE, {
          from_id: cur,
          to_id: tabs[nextIdx].key,
          method: 'swipe',
        });
        // R16 PM 反馈"完成切换后整页闪白":根因是 adjacent unmount + main reset
        // transform 跟 React commit setFilter / 新 Feed mount 不同步, 中间一帧
        // viewport 显白底. 修复:先 setFilter (overlay opacity=1 + 新 Feed mount),
        // 等 React commit 用 raf 双 buffer, 再 resetTransform + cleanup adjacent,
        // overlay 已经盖住 viewport 时 unmount 不闪
        switchChannelRef.current(tabs[nextIdx].key);
        postSwitchRaf = requestAnimationFrame(() => {
          postSwitchRaf = requestAnimationFrame(() => {
            postSwitchRaf = 0;
            resetTransform();
            cleanupAdjacent();
          });
        });
      });
    };
    const onCancel = (e: TouchEvent) => {
      // A cancel for an unrelated touch still invalidates the gesture, but the
      // lookup ensures we never accidentally substitute changedTouches[0].
      if (activeTouchId !== null) findActiveTouch(e.changedTouches);
      cancelSwipeGesture();
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    // R14: passive:false 让 horizontal lock 后 preventDefault 生效,
    // 阻止斜滑时 native vertical scroll 跟 JS horizontal swipe 同时跑
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      cancelSwipeGesture();
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [
    isNarrow,
    reduceMotion,
    renderInkBetween,
    requestAdjacentIntentPrefetch,
    resetInkToActive,
  ]);

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
    let guardTouchId: number | null = null;

    const findGuardTouch = (touches: TouchList) => (
      guardTouchId === null
        ? undefined
        : Array.from(touches).find((touch) => touch.identifier === guardTouchId)
    );
    const resetGuardGesture = () => {
      target = null;
      guardTouchId = null;
      direction = null;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        resetGuardGesture();
        return;
      }
      target = e.target as Element | null;
      const t = e.touches[0];
      guardTouchId = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      direction = null;
    };
    const onMove = (e: TouchEvent) => {
      if (!target) return;
      if (e.touches.length !== 1) {
        resetGuardGesture();
        return;
      }
      const t = findGuardTouch(e.touches);
      if (!t) {
        resetGuardGesture();
        return;
      }
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
    const onEnd = (e: TouchEvent) => {
      if (guardTouchId !== null) findGuardTouch(e.changedTouches);
      resetGuardGesture();
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

  // PR5 share landing is route-specific; global telemetry initialization lives in main.tsx.
  useEffect(() => {
    // PR5 landing 回流：从 /s/:token redirect 过来时 worker 加了
    // ?ref=share&token=<token>&from=<uid>，前端拿到 token 上报 landing
    // 让 worker 把当前 device_id 写入 share_relations.to_did + landed_at
    // 同 token 上报一次后从 sessionStorage 标记，避免刷新页面重复上报
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    const token = params.get('token');
    if (ref === 'share' && token) {
      const flagKey = `share_landing_reported:${token}`;
      try {
        if (!sessionStorage.getItem(flagKey)) {
          import('./lib/share').then(({ reportLanding }) => reportLanding(token));
          sessionStorage.setItem(flagKey, '1');
        }
      } catch {
        // sessionStorage unavailable (incognito iOS Safari) → 直接上报，不去重
        import('./lib/share').then(({ reportLanding }) => reportLanding(token));
      }
    }
  }, []);

  const visibleColumns = SOURCE_COLUMNS.filter((col) => {
    if (filter === "all") return true;
    return col.source_type === filter;
  });

  // VideoCoordinator wiring：列顺序变化时同步 + tab 切换时全停（mount 一次）
  // drawer mode 切换需要 useDrawer，放在 DrawerProvider 内的 <DrawerModeSync /> 里
  const columnOrderKey = visibleColumns.map((c) => c.source_type).join("|");
  useEffect(() => {
    useVideoCoordinator.getState().setColumnOrder(columnOrderKey.split("|"));
  }, [columnOrderKey]);
  useEffect(() => attachVisibilityListener(), []);
  // 登录态 ↔ coordinator prefs 双向 sync（cloud authoritative）
  useEffect(() => attachVideoPrefsSync(), []);

  const getTitleForColumn = (col: SourceConfig): string => {
    if (col.source_type === "x_list") {
      return manifest?.labels.x_list || col.title;
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
    // The last interacted column gets spatial continuity; other columns reset
    // instantly so one app-bar click never starts seven competing animations.
    const preferred = lastInteractedColumnRef.current;
    const animatedColumnId = preferred && feedRefs.current.has(preferred)
      ? preferred
      : visibleColumns[0]?.source_type;
    feedRefs.current.forEach((handle, columnId) => {
      handle?.scrollToTop({ instant: columnId !== animatedColumnId });
    });
  }

  return (
    <DrawerProvider>
    <DrawerModeSync />
    <div className="min-h-screen bg-neutral-50">
      {/* Top bar */}
      {/* PM 2026-05-27 任务 3 v3 反馈: 频道流惯性 momentum 没了 — 根因是 mobile
          sticky header + RAF 每帧 set transform, iOS 把 #root scroll 的 momentum
          节流了 (sticky 每次 scroll 都重算 stickiness offset, 加上 transform write
          → main thread 持续 sync 工作 → iOS disable momentum 优化). 改 fixed 让
          header 完全脱离 #root scroll layout, 改它任何 style 都不影响 #root scroll.
          PC 保持 sticky 不变 (PC 走 window scroll 没这个问题). */}
      <header
        ref={headerRef}
        className="z-10 cursor-pointer border-b border-neutral-200 bg-white/80 backdrop-blur max-md:fixed max-md:inset-x-0 max-md:top-0 sm:sticky sm:top-0"
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
          {/* PM 2026-05-19:移动端 AppBar logo + "AI-Feeds" 改上下结构,
              字号缩到 10px,腾出空间给右侧 tab(原横排单行占 ~120px → 现在 ~40px)。
              PC(sm:+)保持横排不变 */}
          <div className="flex shrink-0 items-center gap-2 max-md:flex-col max-md:items-center max-md:gap-0 md:flex-1">
            <img
              src="/favicon.svg"
              alt="AI-Feeds"
              className="h-7 w-7 max-md:h-5 max-md:w-5 sm:h-8 sm:w-8"
              draggable={false}
            />
            <h1 className="whitespace-nowrap text-lg font-bold tracking-tight text-neutral-900 max-md:text-[10px] max-md:leading-none sm:text-xl">
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
            <nav
              ref={chipRailRef}
              className="chips-rail min-w-0 self-stretch overflow-x-auto"
            >
              {/* Inner scroll content — relative parent for active pill + chips.
                  inline-flex 让宽度跟 chip 内容紧凑 (= scroll content width),
                  nav 自己 overflow-x-auto 自动 scroll 整个 inner div + pill + chips.
                  pill 是 absolute 相对 inner (= scroll content), 跟 chip
                  共享同一个 offsetParent (chip.offsetLeft 跟 pill.transform translateX
                  对齐), 完全不需要 JS 同步 scrollLeft */}
              <div
                ref={chipScrollContentRef}
                className="relative inline-flex h-full items-center gap-1"
              >
                <div
                  className="pointer-events-none absolute inset-0 z-0"
                  aria-hidden
                >
                      <div
                        ref={pillARef}
                        className="motion-channel-pill absolute top-1/2 rounded-full bg-neutral-900"
                    style={{
                      width: 0,
                      height: `${PILL_H}px`,
                      transform: "translateX(0px) translateY(-50%)",
                      transformOrigin: "left center",
                    }}
                  />
                </div>
                {FILTER_CHIPS.filter((c) => c.key !== "all").map(({ key, label }) => {
                const isActive = filter === key;
                const hasData = isChannelLive(key);
                return (
                  <button
                    key={key}
                    ref={(el) => { chipRefs.current[key] = el; }}
                    type="button"
                    data-chip-key={key}
                    onPointerDown={() => requestIntentPrefetch(key)}
                    onFocus={() => requestIntentPrefetch(key)}
                    onClick={() => {
                      if (isActive) {
                        scrollFeedOrPage(null);
                      } else {
                        track(EVENTS.SOURCE_FILTER_CHANGE, { from_id: storedFilter, to_id: key });
                        // 高频点击直接换内容，选中态 pill 自己做 160ms 位移。
                        switchChannel(key);
                      }
                    }}
                    className={cn(
                      "relative z-10 shrink-0 min-w-[64px] rounded-full px-3 py-1 text-center text-xs font-medium transition-colors",
                      isActive ? "text-white" : "text-neutral-600",
                      !hasData && !isActive && "opacity-40",
                    )}
                  >
                    {label}
                  </button>
                );
                })}
              </div>
            </nav>
          )}

          <HomeViewSwitch current="classic" />
          <SearchEntryButton />
          <UserMenu />
        </div>
      </header>

      {/* mobile-only spacer: header 改 fixed 后不占 layout 空间, 加 49px spacer
          补齐 (跟 sticky 时一样让 main 内容从 49 起步). PC sticky 自己占空间,
          不需 spacer. */}
      <div className="max-md:h-[49px] md:hidden" aria-hidden />

      {/* 未登录订阅引导横幅（每日首访展示，可关闭；登录用户不显示）。
          放在 header/spacer 之后、main 之前 → 位于内容流顶部，随页面滚动。 */}
      <SubscribeBanner />

      {/* Swipe adjacent panel — R22 加 channel header (SourceIcon + label) +
          8 SkeletonCard, 跟 Feed mount 后的 header + skeleton 完全一致, 切换
          完成不再"跳一下". */}
      {isNarrow && swipeAdjacent && (
        <div
          ref={adjacentRef}
          className="pointer-events-none fixed inset-x-0 z-30 overflow-hidden bg-white"
          style={{
            top: swipeAdjacent.top,
            bottom: 0,
            transform: `translateX(${swipeAdjacent.side === 'right' ? '100%' : '-100%'})`,
          }}
          aria-hidden
        >
          <ChannelSkeletonPanel filterKey={swipeAdjacent.key} />
        </div>
      )}

      {/* 3-column grid — touch-pan-y (swiper.js / framer-motion 同款) +
          overscroll-y-contain (R16 PM 反馈: 顶部斜滑既切又下拉刷新, 加
          overscroll-behavior-y:contain 阻止 iOS / Android pull-to-refresh 跨域
          滚动链穿透到浏览器, swipe 时只走 JS 不触发系统刷新动作) */}
      <main
        ref={mainRef}
        onScrollCapture={unlockDeferredFeedsFromColumnScroll}
        className="relative mx-auto max-w-[1280px] px-3 py-3 sm:px-8 sm:py-6 lg:px-16 max-md:touch-pan-y max-md:overscroll-y-contain"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {visibleColumns.map((col, index) => {
            const isPlaceholder = !resolveChannelLive(col.source_type, {
              enabled: OPTIMISTIC_FEED_START,
              metadataState,
              live: liveSourceTypes,
            });
            return (
              // 列内任意 click 都标记该列为 lastClickedColumnId，让 VideoCoordinator
              // 在多列同时有视频候选时优先选这列（设计文档 §2.2）。capture 阶段抓
              // bubble 之前所有 click，包含 video element / chip / 卡片自身。
              <div
                key={col.source_type}
                onPointerDownCapture={() => {
                  lastInteractedColumnRef.current = col.source_type;
                  useVideoCoordinator.getState().markColumnClick(col.source_type);
                }}
                onWheelCapture={() => {
                  lastInteractedColumnRef.current = col.source_type;
                }}
              >
                <DeferredFeed
                  ref={(h) => {
                    if (h) feedRefs.current.set(col.source_type, h);
                    else feedRefs.current.delete(col.source_type);
                  }}
                  immediate={index < immediateColumnCount}
                  mediaColumnIndex={index}
                  mediaColumnImmediate={index < immediateColumnCount}
                  observationEnabled={pageHasScrolled}
                  sourceType={col.source_type}
                  title={getTitleForColumn(col)}
                  placeholder={isPlaceholder}
                  refreshTick={refreshTick}
                  onInitialRequestStart={OPTIMISTIC_FEED_START && !shouldLoadManifest ? handleInitialFeedRequestStart : undefined}
                />
              </div>
            );
          })}
        </div>

        <footer className="mt-6 text-center text-xs text-neutral-600">
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
          <span className="mx-1.5">·</span>
          {/* AI 日报是 worker 伺服的纯静态归档页,普通整页导航离开 SPA(不走 react-router Link) */}
          <a href="/daily/" className="hover:text-neutral-600 hover:underline">
            AI 日报
          </a>
          <span className="mx-1.5">·</span>
          <a href="/archive/" className="hover:text-neutral-600 hover:underline">
            内容归档
          </a>
        </footer>
      </main>
      <TweetDrawerGate />
      <QuoteSnapshotModal />
    </div>
    </DrawerProvider>
  );
}

// /s/:token — 兼容老海报：QR 码原本指向 site 域，CF Pages 没这路由，
// 这里 client-side 直接 location.replace 到 worker /s/:token，让 worker
// 处理 share_relations + redirect 到详情页。新海报 QR 直接指 worker，不走这。
function ShareLanding() {
  const { token } = useParams<{ token: string }>();
  useEffect(() => {
    if (!token) return;
    const target = buildPublicWorkerUrl(`/s/${encodeURIComponent(token)}`);
    window.location.replace(target);
  }, [token]);
  return (
    <div className="flex h-screen items-center justify-center text-sm text-neutral-500">
      正在打开分享内容…
    </div>
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
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<DashboardHome />} />
        <Route path="/t/:id" element={<DashboardHome />} />
        <Route path="/g/:owner/:repo" element={<DashboardHome />} />
        <Route path="/ph/:slug/:date" element={<DashboardHome />} />
        <Route path="/c/:slug" element={<DashboardHome />} />
        <Route path="/e/:eventId" element={<DashboardHome />} />
        <Route path="/h/:arxivId" element={<DashboardHome />} />
        {/* /o/:id → 官方新闻（blog + podcast）详情深链。本路由只负责让 SPA 渲染
            DashboardHome（initialFilter 据 pathname 落「官方新闻」tab）；抽屉冷启动
            的 composite-id 解析在 lib/drawer.tsx parseDeepLinkFromPath（跨团队，
            未命中时优雅降级为仅打开频道、不自动开抽屉）。 */}
        <Route path="/o" element={<DashboardHome />} />
        <Route path="/o/:id" element={<DashboardHome />} />
        <Route path="/s/:token" element={<ShareLanding />} />
        {/* C 端搜索页,公开可搜(不包 RequireAuth)。骨架本任务建,内容 Task 10/11 填。 */}
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="/settings/account" element={<RequireAuth><AccountManage /></RequireAuth>} />
        <Route path="/feedback" element={isWeChatBrowser() ? <Navigate to="/" replace /> : <RequireAuth><Feedback /></RequireAuth>} />
        <Route path="/subscribe" element={<Subscription mode="anonymous" />} />
        <Route path="/me/subscription" element={<RequireAuth><Subscription mode="manage" /></RequireAuth>} />
      </Routes>
      </Suspense>
      <LoginModalGate />
      <ToastGate />
    </>
  );
}

export default App;

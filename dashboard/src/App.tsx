import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Feed, type FeedHandle } from "./components/Feed";
import { DrawerProvider } from "./lib/drawer";

// Drawer drags in react-markdown + remark-gfm + rehype-raw (~150kb gzipped).
// Defer it until first drawer open so initial paint isn't blocked by markdown
// deps the user may never need.
const TweetDrawer = lazy(() =>
  import("./components/TweetDrawer").then((m) => ({ default: m.TweetDrawer })),
);

// PR3 quote 嵌套小卡点击 → 站内 modal。轻量(无 markdown 依赖),不 lazy
import { QuoteSnapshotModal } from "./components/QuoteSnapshotModal";

import { fetchSources, fetchStats, TRACK_ENDPOINT, API_BASE } from "./api";
import type { Source, SourceType, Stats } from "./types";
import { cn } from "./lib/utils";
import { useIsNarrow } from "./lib/breakpoint";
import { useVideoCoordinator, attachVisibilityListener } from "./lib/videoCoordinator";
import { attachVideoPrefsSync } from "./lib/videoPrefsSync";
import { useDrawer } from "./lib/drawer";
import { scrollFeedOrPage, smoothScrollWindowToTop } from "./lib/scroll";
import { initTelemetry, track, EVENTS } from "./lib/telemetry";
import { installVitals } from "./lib/telemetry/vitals";
import { installErrorHandlers } from "./lib/telemetry/errors";
import { Routes, Route, useParams } from "react-router";
import { UserMenu } from "./components/UserMenu";
import { RequireAuth } from "./components/RequireAuth";
import { Settings } from "./pages/Settings";
import { AccountManage } from "./pages/AccountManage";
import { useAuthStore } from "./lib/authStore";
import { useToastStore } from "./lib/toast";
import { useChannelSnapshotStore } from "./lib/channelSnapshotStore";

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

interface SourceConfig {
  source_type: SourceType;
  title: string;
}

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
const SOURCE_COLUMNS: SourceConfig[] = [
  { source_type: "x_list", title: "动态" },
  { source_type: "product_hunt", title: "热门产品" },
  { source_type: "huodongxing", title: "活动" },
  { source_type: "github", title: "开源项目" },
  // 2026-05-18：原 arxiv 列重命名为「论文」，source_type 切换到 hf_paper。
  // arxiv source_type 保留在 types.ts 备用（未来如接入非 HF arxiv 源可再加回 COLUMNS）。
  { source_type: "hf_paper", title: "论文" },
  { source_type: "clawhub", title: "龙虾技能" },
  { source_type: "youtube", title: "YouTube" },
  { source_type: "podcast", title: "Podcast" },
];

type FilterKey = "all" | SourceType;

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "x_list", label: "动态" },
  { key: "product_hunt", label: "热门产品" },
  { key: "huodongxing", label: "活动" },
  { key: "github", label: "开源项目" },
  { key: "hf_paper", label: "论文" },
  { key: "clawhub", label: "龙虾技能" },
  { key: "youtube", label: "YouTube" },
  { key: "podcast", label: "Podcast" },
];

function DashboardHome() {
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
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
    return "all";
  })();
  const [storedFilter, setFilter] = useState<FilterKey>(initialFilter);
  const [refreshTick, _setRefreshTick] = useState(0);

  const isNarrow = useIsNarrow();
  const feedRefs = useRef<Map<string, FeedHandle | null>>(new Map());
  // PM 2026-05-19:选中 tab 自动 scrollIntoView 居中 — chip rail 横向滚动容器,
  // filter 切到非可视 chip 时把它居中到 rail 中部,让用户知道这是 active(避免
  // 切了但用户看不到激活状态以为没动)。useEffect 跑在 filter 声明之后(挪到 L155+)
  const chipRailRef = useRef<HTMLElement | null>(null);
  // PM 2026-05-20:#5 横划切 tab — feed 区域 main 上挂 touch listener,
  // 识别 horizontal-dominant swipe 切上/下一个 filter chip
  const mainRef = useRef<HTMLElement | null>(null);

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

  // PM 2026-05-19:active chip 自动 scrollIntoView 居中(声明位置必须在
  // `filter` derived state 之后,否则 TS 报 used-before-declaration)
  useEffect(() => {
    if (!isNarrow || !chipRailRef.current) return;
    const raf = requestAnimationFrame(() => {
      const chip = chipRailRef.current?.querySelector<HTMLButtonElement>(
        `[data-chip-key="${filter}"]`,
      );
      chip?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [filter, isNarrow]);

  // PM 2026-05-25 R10: Channel Transition Snapshot (CTS) — main viewport
  // 自动截图存 store, 切 channel 时显 snapshot 当过渡占位 (避免 Feed mount
  // 前的空白帧). 触发: scrollend (debounce) + filter change 之前 (出场快照).
  // 复用 modern-screenshot (已 install for poster), 单次截图 ~100ms, 0.5x scale
  // 控制 PNG ~50-150KB / channel.
  const captureChannelSnapshot = useRef<(type: string) => Promise<void>>(async () => {});
  useEffect(() => {
    captureChannelSnapshot.current = async (sourceType: string) => {
      const node = mainRef.current;
      if (!node) return;
      try {
        const { domToPng } = await import("modern-screenshot");
        const dataUri = await domToPng(node, {
          scale: 0.5,
          type: "image/png",
          backgroundColor: "#ffffff",
        });
        useChannelSnapshotStore.getState().setSnapshot(sourceType, dataUri);
      } catch (e) {
        // 截图失败不阻塞业务, 切换 transition 走 skeleton
        console.warn("[snapshot] capture failed", e);
      }
    };
  }, []);
  // scrollend (debounce 600ms) 触发当前 filter 截图. requestIdleCallback 避免阻塞 main thread.
  useEffect(() => {
    if (!isNarrow) return;
    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
        if (ric) ric(() => captureChannelSnapshot.current(filterRef.current));
        else setTimeout(() => captureChannelSnapshot.current(filterRef.current), 0);
      }, 600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (timer !== null) clearTimeout(timer);
    };
  }, [isNarrow]);

  // Snapshot overlay state (channel switch 期间显示, setFilter 后 ~200ms fade-out)
  const [transitionOverlay, setTransitionOverlay] = useState<{ from: string; to: string; toSnap: string | null } | null>(null);

  // 切 channel 的统一入口 — 先截出场快照 (current), 显示目标 snapshot 当 overlay, 切 filter
  // useCallback 让 swipe handler 内 ref 捕获稳定 (deps [] 因内部都用 ref / setState)
  const switchChannel = useCallback((nextFilter: string) => {
    if (nextFilter === filterRef.current) return;
    const fromFilter = filterRef.current;
    const toSnap = useChannelSnapshotStore.getState().getSnapshot(nextFilter)?.dataUri || null;
    captureChannelSnapshot.current(fromFilter);
    setTransitionOverlay({ from: fromFilter, to: nextFilter, toSnap });
    setFilter(nextFilter as typeof filter);
    window.setTimeout(() => setTransitionOverlay(null), 220);
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
    let direction: 'unknown' | 'horizontal' | 'vertical' = 'unknown';
    let currentDx = 0;

    const applyTransform = (dx: number, withTransition: boolean) => {
      el.style.transition = withTransition
        ? 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)'
        : 'none';
      el.style.transform = dx === 0 ? '' : `translateX(${dx}px)`;
    };
    const resetTransform = () => {
      el.style.transition = '';
      el.style.transform = '';
    };

    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-drawer-panel]')) return;
      if (target.closest('.chips-rail')) return;
      if (target.closest('video')) return;
      if (target.closest('[data-no-swipe-tab]')) return;
      const t0 = e.touches[0];
      if (t0.clientX < 24) return;
      startX = t0.clientX;
      startY = t0.clientY;
      startT = Date.now();
      direction = 'unknown';
      currentDx = 0;
      active = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const absDx = Math.abs(dx), absDy = Math.abs(dy);
      // 方向未锁定:抖动阈值内等
      if (direction === 'unknown') {
        if (absDx < 10 && absDy < 10) return;
        if (absDx > absDy * 2) {
          direction = 'horizontal';
        } else if (absDy > absDx * 2) {
          direction = 'vertical';
          active = false;
          return;
        } else {
          return; // 模糊区, 等下一帧
        }
      }
      // 横向锁定 → 跟手 translate (边界 tab 往外划阻尼 1/3 反弹)
      if (direction === 'horizontal') {
        const tabs = FILTER_CHIPS.filter((c) => c.key !== 'all');
        const idx = tabs.findIndex((c) => c.key === filterRef.current);
        let dampened = dx;
        if (idx === 0 && dx > 0) dampened = dx / 3;
        else if (idx === tabs.length - 1 && dx < 0) dampened = dx / 3;
        currentDx = dampened;
        applyTransform(dampened, false);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (!active || direction !== 'horizontal') {
        active = false;
        resetTransform();
        return;
      }
      active = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Date.now() - startT;
      const tabs = FILTER_CHIPS.filter((c) => c.key !== 'all');
      const cur = filterRef.current;
      const idx = tabs.findIndex((c) => c.key === cur);

      const shouldSwitch =
        Math.abs(dx) >= 60 &&
        Math.abs(dx) >= Math.abs(dy) * 1.5 &&
        dt <= 800 &&
        idx >= 0;
      const nextIdx = !shouldSwitch ? idx : (dx < 0
        ? Math.min(idx + 1, tabs.length - 1)
        : Math.max(idx - 1, 0));

      if (!shouldSwitch || nextIdx === idx) {
        // 弹回 0
        applyTransform(0, true);
        const onTransitionEnd = () => {
          el.removeEventListener('transitionend', onTransitionEnd);
          resetTransform();
        };
        el.addEventListener('transitionend', onTransitionEnd);
        return;
      }
      // animate off-screen 然后 switchChannel (CTS overlay 接管 transition)
      const width = el.offsetWidth || window.innerWidth;
      const target = dx < 0 ? -width : width;
      applyTransform(target, true);
      const onTransitionEnd = () => {
        el.removeEventListener('transitionend', onTransitionEnd);
        track(EVENTS.SOURCE_FILTER_CHANGE, {
          from_id: cur,
          to_id: tabs[nextIdx].key,
          method: 'swipe',
        });
        // 重置 transform → 主容器回原位, overlay (CTS snapshot) 覆盖 transition gap
        resetTransform();
        switchChannelRef.current(tabs[nextIdx].key);
      };
      el.addEventListener('transitionend', onTransitionEnd);
      void currentDx; // referenced for closure capture across handlers
    };
    const onCancel = () => {
      if (active && direction === 'horizontal') {
        applyTransform(0, true);
      }
      active = false;
      direction = 'unknown';
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [isNarrow]);

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
    <DrawerModeSync />
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
          {/* PM 2026-05-19:移动端 AppBar logo + "AI-Feeds" 改上下结构,
              字号缩到 10px,腾出空间给右侧 tab(原横排单行占 ~120px → 现在 ~40px)。
              PC(sm:+)保持横排不变 */}
          <div className="flex shrink-0 items-center gap-2 max-md:flex-col max-md:items-center max-md:gap-0">
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
              className="chips-rail flex min-w-0 items-center gap-1 self-stretch overflow-x-auto"
            >
              {FILTER_CHIPS.filter((c) => c.key !== "all").map(({ key, label }) => {
                const isActive = filter === key;
                const hasData = liveSourceTypes.has(key as SourceType);
                return (
                  <button
                    key={key}
                    type="button"
                    data-chip-key={key}
                    onClick={() => {
                      if (isActive) {
                        scrollFeedOrPage(null);
                      } else {
                        track(EVENTS.SOURCE_FILTER_CHANGE, { from_id: storedFilter, to_id: key });
                        // 走 CTS overlay 过渡, 避免 chip click 切换的 "空白帧"
                        switchChannel(key);
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
      <main
        ref={mainRef}
        className="relative mx-auto max-w-[1280px] px-3 py-3 sm:px-8 sm:py-6 lg:px-16"
      >
        {/* CTS overlay — channel 切换 transition 期间显目标 channel snapshot
            (5min TTL, 无 / 过期 → skeleton). 220ms 后 fade-out 给真 Feed 接管. */}
        {isNarrow && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 overflow-hidden bg-white"
            style={{
              height: "calc(100vh - 64px)",
              opacity: transitionOverlay ? 1 : 0,
              transition: transitionOverlay ? "none" : "opacity 220ms ease-out",
            }}
            aria-hidden
          >
            {transitionOverlay && (transitionOverlay.toSnap ? (
              <img
                src={transitionOverlay.toSnap}
                alt=""
                className="h-full w-full object-cover object-top"
                draggable={false}
              />
            ) : (
              <div className="h-full w-full animate-pulse bg-neutral-100" />
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {visibleColumns.map((col) => {
            const isPlaceholder = !liveSourceTypes.has(col.source_type);
            return (
              // 列内任意 click 都标记该列为 lastClickedColumnId，让 VideoCoordinator
              // 在多列同时有视频候选时优先选这列（设计文档 §2.2）。capture 阶段抓
              // bubble 之前所有 click，包含 video element / chip / 卡片自身。
              <div
                key={col.source_type}
                onClickCapture={() =>
                  useVideoCoordinator.getState().markColumnClick(col.source_type)
                }
              >
                <Feed
                  ref={(h) => {
                    if (h) feedRefs.current.set(col.source_type, h);
                    else feedRefs.current.delete(col.source_type);
                  }}
                  sourceType={col.source_type}
                  title={getTitleForColumn(col)}
                  placeholder={isPlaceholder}
                  refreshTick={refreshTick}
                />
              </div>
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
    const target = `${API_BASE || 'https://api.ai-feeds.com'}/s/${encodeURIComponent(token)}`;
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
      <Routes>
        <Route path="/" element={<DashboardHome />} />
        <Route path="/t/:id" element={<DashboardHome />} />
        <Route path="/g/:owner/:repo" element={<DashboardHome />} />
        <Route path="/ph/:slug/:date" element={<DashboardHome />} />
        <Route path="/c/:slug" element={<DashboardHome />} />
        <Route path="/e/:eventId" element={<DashboardHome />} />
        <Route path="/h/:arxivId" element={<DashboardHome />} />
        <Route path="/s/:token" element={<ShareLanding />} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="/settings/account" element={<RequireAuth><AccountManage /></RequireAuth>} />
      </Routes>
      <LoginModalGate />
      <ToastGate />
    </>
  );
}

export default App;

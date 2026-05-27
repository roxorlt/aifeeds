import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Feed, SkeletonCard, type FeedHandle } from "./components/Feed";
import { SourceIcon } from "./components/icons";
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
import { useFancyAnimation } from "./lib/useFancyAnimation";
import {
  PILL_H,
  computeOutPillSize,
  computeInPillSize,
  jitterAmpOut,
  jitterAmpIn,
  computeBridgeHalfH,
  buildBridgePath,
} from "./lib/inkPill";
import { useVideoCoordinator, attachVisibilityListener } from "./lib/videoCoordinator";
import { attachVideoPrefsSync } from "./lib/videoPrefsSync";
import { useDrawer } from "./lib/drawer";
import { scrollFeedOrPage, smoothScrollWindowToTop } from "./lib/scroll";
import { addScrollRootListener, getScrollY } from "./lib/scrollRoot";
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
  // PM 2026-05-27: chip-rail 内层 scroll content wrapper — ink-layer + chips 都在
  // 这个 inline-flex 内, nav 自己 overflow-x-auto 自动 scroll 整个 wrapper, ink-layer
  // 跟 chip 共享同一 offsetParent → 完全不需要 JS 同步 scrollLeft
  const chipScrollContentRef = useRef<HTMLDivElement | null>(null);
  // PM 2026-05-27 任务 2 v5 实现 (demo: docs/mocks/2026-05-27-channel-tab-ink.html):
  //   - pillA: 出场 pill (无 swipe 时落 active chip 当 baseline);
  //   - pillB: 入场 pill (fancy mode 才渲染, swipe 期间从 to-chip 中心扩展);
  //   - bridgePath: 流体连线 SVG path (fancy mode 才渲染);
  //   - inkLayer: 上述三者的容器, fancy mode 套 goo filter → metaball 合并液态.
  // fancyAnim=false (低端设备 / prefers-reduced-motion) 走朴素: 只 pillA 单 pill 位置/宽度 lerp.
  const inkLayerRef = useRef<HTMLDivElement | null>(null);
  const pillARef = useRef<HTMLDivElement | null>(null);
  const pillBRef = useRef<HTMLDivElement | null>(null);
  const bridgePathRef = useRef<SVGPathElement | null>(null);
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // 之前用 chipRectsRef cache 想砍 touchmove DOM read, 但 cache stale 导致 pill
  // 位置错 (PM 2026-05-27 反馈 chip 黑框跨"热门产品"末尾跟"活动"). 回滚直接 read DOM —
  // browser 没改动 layout 时 offsetLeft 读取走 layout cache, 60Hz 4 次 read 实际成本
  // 比想象低; pill 准确性 > 微小 perf 优化
  const fancyAnim = useFancyAnimation();
  const fancyAnimRef = useRef(fancyAnim);
  fancyAnimRef.current = fancyAnim;
  // swipe 状态: 让 fancy mode RAF loop 期间能持续重绘 (sin 波相位随时间演变)
  const swipeStateRef = useRef<{ active: boolean; fromKey: string; toKey: string; progress: number }>({
    active: false, fromKey: "", toKey: "", progress: 0,
  });
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

  // PM 2026-05-27 v5 helpers (chip click + swipe end reset baseline):
  // resetInkToActive: pillA 落到 active chip (= 完整 chip.w/PILL_H 胶囊),
  //                   pillB 隐藏, bridge 清空. 是"无 swipe 稳定态".
  // renderInkBetween: swipe 期间根据 progress 0..1 在 from/to chip 之间
  //                   渲染 fancy 流体动效 (出/入两阶段缩 + 流体连线), 或朴素
  //                   单 pill lerp.
  const resetInkToActive = useCallback((key: string, withTransition: boolean) => {
    const pillA = pillARef.current;
    const pillB = pillBRef.current;
    const bridgePath = bridgePathRef.current;
    const chip = chipRefs.current[key];
    if (!pillA || !chip) return;
    const trans = withTransition
      ? "transform 220ms cubic-bezier(0.32, 0.72, 0, 1), width 220ms cubic-bezier(0.32, 0.72, 0, 1), height 220ms cubic-bezier(0.32, 0.72, 0, 1)"
      : "none";
    pillA.style.transition = trans;
    pillA.style.width = `${chip.offsetWidth}px`;
    pillA.style.height = `${PILL_H}px`;
    pillA.style.transform = `translate(${chip.offsetLeft}px, -50%)`;
    if (pillB) {
      pillB.style.transition = trans;
      pillB.style.width = "0px";
      pillB.style.height = "0px";
    }
    if (bridgePath) bridgePath.setAttribute("d", "");
  }, []);

  const renderInkBetween = useCallback((fromKey: string, toKey: string, progress: number) => {
    const pillA = pillARef.current;
    const pillB = pillBRef.current;
    const bridgePath = bridgePathRef.current;
    const inkLayer = inkLayerRef.current;
    const fromChip = chipRefs.current[fromKey];
    const toChip = chipRefs.current[toKey];
    if (!pillA || !fromChip || !toChip) return;
    const fromRect = { left: fromChip.offsetLeft, width: fromChip.offsetWidth };
    const toRect = { left: toChip.offsetLeft, width: toChip.offsetWidth };
    const fancy = fancyAnimRef.current;

    if (!fancy) {
      // 朴素: 单 pill 在 from/to chip 之间 lerp 位置/宽度
      const p = Math.max(0, Math.min(1, progress));
      const lerp = (a: number, b: number) => a + (b - a) * p;
      pillA.style.transition = "none";
      pillA.style.transform = `translate(${lerp(fromRect.left, toRect.left)}px, -50%)`;
      pillA.style.width = `${lerp(fromRect.width, toRect.width)}px`;
      pillA.style.height = `${PILL_H}px`;
      return;
    }

    // Fancy v5 流体动效
    if (!pillB || !bridgePath || !inkLayer) return;
    const fromCenter = fromRect.left + fromRect.width / 2;
    const toCenter = toRect.left + toRect.width / 2;
    const ymid = inkLayer.clientHeight / 2;
    const now = performance.now();

    // 出场 / 入场 pill 大小 (smoothstep ease) + 微小 jitter (关键帧 amp=0)
    const out = computeOutPillSize(progress, fromRect.width);
    const inS = computeInPillSize(progress, toRect.width);
    const jOut = jitterAmpOut(progress);
    const jIn = jitterAmpIn(progress);
    const ow = Math.max(0, out.w + Math.sin(now / 850) * jOut);
    const oh = Math.max(0, out.h + Math.cos(now / 720 + 1.2) * jOut * 0.8);
    const bw = Math.max(0, inS.w + Math.sin(now / 920 + 2.1) * jIn);
    const bh = Math.max(0, inS.h + Math.cos(now / 770 + 0.5) * jIn * 0.8);

    pillA.style.transition = "none";
    pillA.style.width = `${ow}px`;
    pillA.style.height = `${oh}px`;
    pillA.style.transform = `translate(${fromCenter - ow / 2}px, -50%)`;
    pillB.style.transition = "none";
    pillB.style.width = `${bw}px`;
    pillB.style.height = `${bh}px`;
    pillB.style.transform = `translate(${toCenter - bw / 2}px, -50%)`;

    // 流体连线
    const halfH = computeBridgeHalfH(progress);
    const reverse = toCenter < fromCenter;
    let xL: number, xR: number, leftH: number, rightH: number;
    if (!reverse) {
      xL = fromCenter + ow / 2 - 3;
      xR = toCenter - bw / 2 + 3;
      leftH = oh;
      rightH = bh;
    } else {
      xL = toCenter + bw / 2 - 3;
      xR = fromCenter - ow / 2 + 3;
      leftH = bh;
      rightH = oh;
    }
    bridgePath.setAttribute("d", buildBridgePath({ xL, xR, leftH, rightH, halfH, ymid, now }));
  }, []);

  // PM 2026-05-27: ink-layer 现在跟 chips 在同一个 scroll-content wrapper 内,
  // nav 的 overflow-x scroll 会自动带着 ink-layer + chips 一起移动, 不需要 JS sync

  // PM 2026-05-27 v5: fancy mode swipe 期间 RAF 持续重绘 (流体连线 sin 波相位
  // 随时间演变, 即使 progress 没变也得每帧 redraw). swipe end → swipeStateRef.active
  // 翻 false 后 RAF 跳过 render, CSS transition 接管 220ms 收尾动画
  useEffect(() => {
    if (!isNarrow || !fancyAnim) return;
    let raf = 0;
    const tick = () => {
      const s = swipeStateRef.current;
      if (s.active) renderInkBetween(s.fromKey, s.toKey, s.progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isNarrow, fancyAnim, renderInkBetween]);

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

  // PM 2026-05-27 v5: filter 切换后 pillA slide 到新 active chip + 重置 pillB/bridge.
  // - chip click 走 switchChannel → setFilter → 此 effect → pillA transition slide 过去;
  // - swipe end (touchend onTransitionEnd) 已手动 reset, 此 effect 跑只是同步同状态;
  // - first mount 不跑 transition (避免 pillA 从 (0,0) "滑入" active chip 首屏怪异).
  const isFirstPillSyncRef = useRef(true);
  useEffect(() => {
    if (!isNarrow) return;
    const raf = requestAnimationFrame(() => {
      resetInkToActive(filter, !isFirstPillSyncRef.current);
      isFirstPillSyncRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [filter, isNarrow, resetInkToActive]);

  // PM 2026-05-25 R10/R12: Channel Transition system
  // - transitionActive: chip click 后的过渡 overlay (fade 220ms)
  // - swipeAdjacent: swipe 期间 mount 邻居 panel (skeleton), 跟 main 同步 translate
  //   让用户看到双 panel 紧贴跟手 (multi-column 效果, 不真 mount Feed 避免成本)
  // R22: transition / adjacent state 加 key, 让 overlay / adjacent 能渲对应
  // channel 的 header (SourceIcon + label), 跟 Feed mount 后的 header 视觉一致,
  // 切换瞬间不再"跳一下"
  const [transitionActive, setTransitionActive] = useState<{ key: string } | null>(null);
  const [swipeAdjacent, setSwipeAdjacent] = useState<{ side: "left" | "right"; key: string } | null>(null);
  const adjacentRef = useRef<HTMLDivElement>(null);
  // PM 2026-05-27 任务 3 v4: header autohide 走双通路.
  // - 新浏览器 (iOS Safari 26+ / Chrome 115+): CSS scroll-driven animation
  //   (index.css 内 @supports + scroll-timeline), 完全 GPU, JS skip RAF.
  //   注意: CSS scroll() 是 scrollY-based, 不是 direction-based (规范限制),
  //   行为类似 iOS Safari address bar (scroll 50-99px 1:1 渐隐).
  // - 旧浏览器 (iOS 17-25 / Chrome 旧版): JS RAF fallback, direction-based
  //   累积 deltaY (上滑就隐下滑就显 — Twitter mobile / 头条手感).
  // - prefers-reduced-motion: 整体 disable, header 永远显示.
  const headerRef = useRef<HTMLElement>(null);
  const hideRatioRef = useRef(0);
  // feature detection runtime: 不会变, 一次即可
  const scrollTimelineSupportedRef = useRef<boolean>(
    typeof window !== "undefined" &&
      typeof CSS !== "undefined" &&
      CSS.supports("animation-timeline", "scroll()"),
  );
  const reducedMotionRef = useRef<boolean>(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const apply = (ratio: number) => {
      const h = headerRef.current;
      if (!h) return;
      h.style.transform = `translateY(${-ratio * 100}%)`;
      h.style.opacity = `${1 - ratio}`;
    };
    if (!isNarrow) {
      hideRatioRef.current = 0;
      apply(0);
      return;
    }
    // CSS scroll-driven 接管: JS 不挂 listener, 不动 inline style (让 CSS animation 跑)
    if (scrollTimelineSupportedRef.current && !reducedMotionRef.current) {
      // 清空 inline style 万一之前 fallback 路径写过
      const h = headerRef.current;
      if (h) {
        h.style.transform = "";
        h.style.opacity = "";
      }
      return;
    }
    // prefers-reduced-motion: 完全不跑 autohide
    if (reducedMotionRef.current) {
      hideRatioRef.current = 0;
      apply(0);
      return;
    }
    const TOP_ZONE = 50;
    const HEADER_H = 49;
    let ticking = false;
    let lastY = getScrollY();
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
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
    return addScrollRootListener(handler);
  }, [isNarrow]);
  // chip click / swipe 切 channel 时 header 强制显示 — overlay 用 top:49 hardcode header
  // 高度做位置, header hidden 状态下切 channel 会留 49px 空白条. 切 channel 是 user
  // 主动 interaction, 配合 show header 也符合 "看到新 channel 标识" 的直觉.
  // 双通路: CSS 路径下 toggle .header-no-autohide class (CSS override scroll-driven);
  // JS fallback 路径下 reset inline style.
  useEffect(() => {
    const forceShow = !!(transitionActive || swipeAdjacent);
    const h = headerRef.current;
    if (!h) return;
    if (scrollTimelineSupportedRef.current && !reducedMotionRef.current) {
      h.classList.toggle("header-no-autohide", forceShow);
    } else if (forceShow) {
      hideRatioRef.current = 0;
      h.style.transform = "translateY(0%)";
      h.style.opacity = "1";
    }
  }, [transitionActive, swipeAdjacent]);
  const switchChannel = useCallback((nextFilter: string) => {
    if (nextFilter === filterRef.current) return;
    setTransitionActive({ key: nextFilter });
    setFilter(nextFilter as typeof filter);
    window.setTimeout(() => setTransitionActive(null), 220);
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
    let currentSide: 'left' | 'right' | null = null;
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
      currentSide = null;
      active = true;
      // R22: 架构改造后 body 永久 fixed, PTR 根本不存在, touchstart 不需要
      // 任何 lockBody. lockBody 移到 onMove direction lock horizontal 时调,
      // 不影响 vertical scroll (R21 之前 touchstart lock 让 vertical 也被锁,
      // 导致 PM 反馈"竖直方向无法上划")
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const absDx = Math.abs(dx), absDy = Math.abs(dy);
      // R17:direction lock 之前的第一帧也 preventDefault, 防 iOS / Android
      // 在顶部启动 pull-to-refresh (PM 反馈 #3:滑频道同时下拉刷新文案露出).
      // overscroll-behavior-y:none 没用是因为 pull-to-refresh 在 touchstart
      // 阶段决定, native scroll 启动后即使后续 preventDefault 也停不下来.
      // 首帧 preventDefault → 浏览器知道 JS 要 capture, 不启动 pull-to-refresh.
      if (direction === 'unknown') {
        if (absDx + absDy < 10) {
          // 抖动阈值内, 但仍 preventDefault 防 pull-to-refresh 启动
          if (e.cancelable) e.preventDefault();
          return;
        }
        if (absDx > absDy) {
          direction = 'horizontal';
        } else {
          direction = 'vertical';
          active = false;
          // R22: vertical lock, JS 不动 main, #root native scroll 接管
          return;
        }
      }
      if (direction === 'horizontal') {
        // R22: 架构改造后 PTR 不存在 (body 永久 fixed), 不再需要 preventDefault
        // + lockBody hack (它们反而拦了 #root native vertical scroll, 导致 PM
        // 反馈竖直方向上划失效). horizontal 锁定后只跟手 translate 即可.
        if (e.cancelable) e.preventDefault();
        const tabs = FILTER_CHIPS.filter((c) => c.key !== 'all');
        const idx = tabs.findIndex((c) => c.key === filterRef.current);
        const targetIdx = dx < 0 ? idx + 1 : idx - 1;
        const atBoundary = targetIdx < 0 || targetIdx >= tabs.length;
        // mount adjacent panel (一次) — side 由 dx 方向定, key 是目标 channel
        if (!atBoundary) {
          const newSide: 'left' | 'right' = dx < 0 ? 'right' : 'left';
          if (currentSide !== newSide) {
            currentSide = newSide;
            setSwipeAdjacent({ side: newSide, key: tabs[targetIdx].key });
          }
        }
        // main 跟手 translate (边界 tab 阻尼 1/3)
        const dampened = atBoundary ? dx / 3 : dx;
        applyMainTransform(dampened, false);
        if (!atBoundary) applyAdjacentTransform(dampened, false);
        // 墨汁动效: fancy 走 v5 两阶段缩 + 流体连线, 朴素走单 pill lerp
        // progress 按 viewport 算 (main 滑 1 屏 = 切换完成).
        // fancy mode 时同步给 swipeStateRef, RAF loop 每帧重绘 (sin 波随时间演变)
        if (!atBoundary) {
          const w = window.innerWidth;
          const progress = Math.min(Math.abs(dx) / w, 1);
          swipeStateRef.current = {
            active: true,
            fromKey: filterRef.current,
            toKey: tabs[targetIdx].key,
            progress,
          };
          renderInkBetween(filterRef.current, tabs[targetIdx].key, progress);
        }
      }
    };
    const onEnd = (e: TouchEvent) => {
      const cleanupAdjacent = () => {
        currentSide = null;
        setSwipeAdjacent(null);
      };
      // swipe 结束 → RAF loop 停渲染 (resetInkToActive 由 CSS transition 接管动画)
      swipeStateRef.current.active = false;
      if (!active || direction !== 'horizontal') {
        active = false;
        resetTransform();
        cleanupAdjacent();
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

      if (!shouldSwitch || nextIdx === idx) {
        // 弹回 0 — main + adjacent 同步 animate 回原位
        applyMainTransform(0, true);
        applyAdjacentTransform(0, true);
        // 墨汁动效回弹到 from-chip baseline (transition 220ms)
        resetInkToActive(cur, true);
        const onTransitionEnd = () => {
          el.removeEventListener('transitionend', onTransitionEnd);
          resetTransform();
          cleanupAdjacent();
        };
        el.addEventListener('transitionend', onTransitionEnd);
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
      const onTransitionEnd = () => {
        el.removeEventListener('transitionend', onTransitionEnd);
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
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resetTransform();
            cleanupAdjacent();
          });
        });
      };
      el.addEventListener('transitionend', onTransitionEnd);
    };
    const onCancel = () => {
      swipeStateRef.current.active = false;
      if (active && direction === 'horizontal') {
        applyMainTransform(0, true);
        applyAdjacentTransform(0, true);
        // 墨汁动效回弹到原 chip
        resetInkToActive(filterRef.current, true);
      }
      active = false;
      direction = 'unknown';
      currentSide = null;
      setSwipeAdjacent(null);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    // R14: passive:false 让 horizontal lock 后 preventDefault 生效,
    // 阻止斜滑时 native vertical scroll 跟 JS horizontal swipe 同时跑
    el.addEventListener('touchmove', onMove, { passive: false });
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
      {/* SVG defs for chip 墨汁动效 goo filter — 全局一份, 仅 fancy mode 引用.
          feGaussianBlur stdDeviation=6 + feColorMatrix alpha 高对比度 → 两个相邻
          黑色形状在边界处 metaball 自然合并, 远了各自独立. */}
      {fancyAnim && (
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <defs>
            <filter id="chip-goo">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feColorMatrix
                in="blur"
                mode="matrix"
                values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
                result="goo"
              />
              <feBlend in="SourceGraphic" in2="goo" />
            </filter>
          </defs>
        </svg>
      )}
      {/* Top bar */}
      {/* PM 2026-05-27 任务 3 v3 反馈: 频道流惯性 momentum 没了 — 根因是 mobile
          sticky header + RAF 每帧 set transform, iOS 把 #root scroll 的 momentum
          节流了 (sticky 每次 scroll 都重算 stickiness offset, 加上 transform write
          → main thread 持续 sync 工作 → iOS disable momentum 优化). 改 fixed 让
          header 完全脱离 #root scroll layout, 改它任何 style 都不影响 #root scroll.
          PC 保持 sticky 不变 (PC 走 window scroll 没这个问题). */}
      <header
        ref={headerRef}
        className={cn(
          "z-10 cursor-pointer border-b border-neutral-200 bg-white/80 backdrop-blur max-md:fixed max-md:inset-x-0 max-md:top-0 sm:sticky sm:top-0",
          // header-autohide-css 触发 index.css 内的 CSS scroll-driven animation (@supports +
          // @media (max-width:767px) 内部, 旧浏览器无副作用). prefers-reduced-motion 时
          // class 不加 + CSS 也被 media query 排除掉双重保险.
          isNarrow && scrollTimelineSupportedRef.current && !reducedMotionRef.current && "header-autohide-css",
        )}
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
              className="chips-rail min-w-0 self-stretch overflow-x-auto"
            >
              {/* Inner scroll content — relative parent for ink-layer + chips.
                  inline-flex 让宽度跟 chip 内容紧凑 (= scroll content width),
                  nav 自己 overflow-x-auto 自动 scroll 整个 inner div + ink-layer + chips.
                  这样 ink-layer 是 absolute 相对 inner (= scroll content), 跟 chip
                  共享同一个 offsetParent (chip.offsetLeft 跟 pill.transform translateX
                  对齐), 完全不需要 JS 同步 scrollLeft */}
              <div
                ref={chipScrollContentRef}
                className="relative inline-flex h-full items-center gap-1"
              >
                {/* 墨汁 ink layer — pillA (出场/baseline) + pillB (入场, fancy 才渲染)
                    + bridge SVG path (流体连线, fancy 才渲染). 套 goo filter 让三者 metaball
                    合并成液态. pointer-events-none 不拦 chip click. 初始 width:0 避免
                    chip mount 前闪一帧 */}
                <div
                  ref={inkLayerRef}
                  className="pointer-events-none absolute inset-0 z-0"
                  style={fancyAnim ? { filter: "url(#chip-goo)" } : undefined}
                  aria-hidden
                >
                  {fancyAnim && (
                    <svg
                      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                      aria-hidden
                    >
                      <path ref={bridgePathRef} fill="#111" d="" />
                    </svg>
                  )}
                  <div
                    ref={pillARef}
                    className="absolute top-1/2 rounded-full bg-neutral-900"
                    style={{ width: 0, height: `${PILL_H}px`, transform: "translate(0px, -50%)" }}
                  />
                  {fancyAnim && (
                    <div
                      ref={pillBRef}
                      className="absolute top-1/2 rounded-full bg-neutral-900"
                      style={{ width: 0, height: 0, transform: "translate(0px, -50%)" }}
                    />
                  )}
                </div>
                {FILTER_CHIPS.filter((c) => c.key !== "all").map(({ key, label }) => {
                const isActive = filter === key;
                const hasData = liveSourceTypes.has(key as SourceType);
                return (
                  <button
                    key={key}
                    ref={(el) => { chipRefs.current[key] = el; }}
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

          <UserMenu />
        </div>
      </header>

      {/* mobile-only spacer: header 改 fixed 后不占 layout 空间, 加 49px spacer
          补齐 (跟 sticky 时一样让 main 内容从 49 起步, swipeAdjacent / transitionActive
          overlay 的 top:49 hardcode 也无需变). PC sticky 自己占空间, 不需 spacer. */}
      <div className="max-md:h-[49px] md:hidden" aria-hidden />

      {/* Swipe adjacent panel — R22 加 channel header (SourceIcon + label) +
          8 SkeletonCard, 跟 Feed mount 后的 header + skeleton 完全一致, 切换
          完成不再"跳一下". */}
      {isNarrow && swipeAdjacent && (
        <div
          ref={adjacentRef}
          className="pointer-events-none fixed inset-x-0 z-30 overflow-hidden bg-white"
          style={{
            top: 49,
            bottom: 0,
            transform: `translateX(${swipeAdjacent.side === 'right' ? '100%' : '-100%'})`,
          }}
          aria-hidden
        >
          <ChannelSkeletonPanel filterKey={swipeAdjacent.key} />
        </div>
      )}

      {/* Chip click transition overlay — R22 也加 header */}
      {isNarrow && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 overflow-hidden bg-white"
          style={{
            top: 49,
            bottom: 0,
            opacity: transitionActive ? 1 : 0,
            transition: transitionActive ? "none" : "opacity 220ms ease-out",
          }}
          aria-hidden
        >
          {transitionActive && <ChannelSkeletonPanel filterKey={transitionActive.key} />}
        </div>
      )}

      {/* 3-column grid — touch-pan-y (swiper.js / framer-motion 同款) +
          overscroll-y-contain (R16 PM 反馈: 顶部斜滑既切又下拉刷新, 加
          overscroll-behavior-y:contain 阻止 iOS / Android pull-to-refresh 跨域
          滚动链穿透到浏览器, swipe 时只走 JS 不触发系统刷新动作) */}
      <main
        ref={mainRef}
        className="relative mx-auto max-w-[1280px] px-3 py-3 sm:px-8 sm:py-6 lg:px-16 max-md:touch-pan-y max-md:overscroll-y-contain"
      >
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

import { lazy, Suspense, useEffect, useRef } from "react";
import { DrawerProvider } from "../lib/drawer";
import { useDrawer } from "../lib/drawerContext";
import { useIsNarrow } from "../lib/breakpoint";
import { addScrollRootListener, getScrollY } from "../lib/scrollRoot";
import { useReducedMotion } from "../lib/useReducedMotion";
import type { HomeFeedResponse } from "../types";
import { HomeViewSwitch } from "./HomeViewSwitch";
import { WaterfallHome } from "./WaterfallHome";
import { nextWaterfallHeaderRatio } from "./waterfallHeader";

const TweetDrawer = lazy(() =>
  import("../components/TweetDrawer").then((module) => ({ default: module.TweetDrawer })),
);

function WaterfallDrawerGate() {
  const { state } = useDrawer();
  const needed = Boolean(state.item) || state.loading || Boolean(state.error);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("../components/TweetDrawer");
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, []);
  if (!needed) return null;
  return (
    <Suspense fallback={null}>
      <TweetDrawer />
    </Suspense>
  );
}

export function WaterfallShell({ initialData }: { initialData: HomeFeedResponse }) {
  const headerRef = useRef<HTMLElement>(null);
  const hideRatioRef = useRef(0);
  const isNarrow = useIsNarrow();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const apply = (ratio: number) => {
      const header = headerRef.current;
      if (!header) return;
      header.style.transform = `translateY(${-ratio * 100}%)`;
      header.style.opacity = `${1 - ratio}`;
    };
    if (!isNarrow || reduceMotion) {
      hideRatioRef.current = 0;
      apply(0);
      return undefined;
    }

    let frame: number | null = null;
    let lastY = getScrollY();
    const handleScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const y = getScrollY();
        const next = nextWaterfallHeaderRatio({
          y,
          delta: y - lastY,
          ratio: hideRatioRef.current,
        });
        lastY = y;
        if (next === hideRatioRef.current) return;
        hideRatioRef.current = next;
        apply(next);
      });
    };
    const removeScrollListener = addScrollRootListener(handleScroll);
    return () => {
      removeScrollListener();
      if (frame !== null) window.cancelAnimationFrame(frame);
      hideRatioRef.current = 0;
      apply(0);
    };
  }, [isNarrow, reduceMotion]);

  return (
    <div className="waterfall-page">
      <a className="waterfall-skip-link" href="#content">跳到内容</a>
      <header ref={headerRef} className="waterfall-appbar">
        <a className="waterfall-brand" href="/" aria-label="AI-Feeds 首页">
          <img src="/favicon.svg" width="32" height="32" alt="" />
          <span>
            <strong>AI-Feeds</strong>
            <small>专注 AI 领域信息聚合</small>
          </span>
        </a>
        <div className="waterfall-appbar__actions">
          <HomeViewSwitch current="waterfall" available />
          <a className="waterfall-icon-link" href="/search" aria-label="搜索">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
          </a>
        </div>
      </header>
      <div className="waterfall-appbar-spacer" aria-hidden />
      <DrawerProvider>
        <WaterfallHome initialData={initialData} />
        <WaterfallDrawerGate />
      </DrawerProvider>
    </div>
  );
}

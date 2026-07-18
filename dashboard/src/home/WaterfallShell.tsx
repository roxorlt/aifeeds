import { lazy, Suspense, useEffect } from "react";
import { DrawerProvider } from "../lib/drawer";
import { useDrawer } from "../lib/drawerContext";
import type { HomeFeedResponse } from "../types";
import { HomeViewSwitch } from "./HomeViewSwitch";
import { WaterfallHome } from "./WaterfallHome";

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
  return (
    <div className="waterfall-page">
      <a className="waterfall-skip-link" href="#content">跳到内容</a>
      <header className="waterfall-appbar">
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
      <DrawerProvider>
        <WaterfallHome initialData={initialData} />
        <WaterfallDrawerGate />
      </DrawerProvider>
    </div>
  );
}

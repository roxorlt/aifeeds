import { useState } from "react";
import { EVENTS, track } from "../lib/telemetry";
import {
  HOME_VIEW_MODES,
  serializeHomeViewCookie,
  type HomeViewMode,
} from "./viewMode";
import "./home-view-switch.css";

type Props = Readonly<{
  current: HomeViewMode;
  available?: boolean;
}>;

function documentDeclaresAvailability(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-home-view-available") === "true";
}

function labelFor(mode: HomeViewMode): string {
  return mode === "classic" ? "经典" : "瀑布";
}

function persistHomeView(mode: HomeViewMode): void {
  document.cookie = serializeHomeViewCookie(mode);
}

export function HomeViewSwitch({
  current,
  available = documentDeclaresAvailability(),
}: Props) {
  const [switching, setSwitching] = useState(false);
  if (!available) return null;

  const select = (nextMode: HomeViewMode) => {
    if (switching || nextMode === current) return;
    setSwitching(true);
    persistHomeView(nextMode);
    track(EVENTS.HOME_VIEW_SWITCH, {
      from_view: current,
      to_view: nextMode,
      entry: "appbar",
    });
    const target = new URL(window.location.href);
    target.searchParams.set("view", nextMode);
    target.searchParams.delete("from");
    window.location.assign(`${target.pathname}${target.search}${target.hash}`);
  };

  const buttons = HOME_VIEW_MODES.map((mode) => (
    <button
      key={mode}
      type="button"
      aria-pressed={current === mode}
      disabled={switching}
      onClick={() => select(mode)}
    >
      {labelFor(mode)}
    </button>
  ));

  return (
    <>
      <nav className="home-view-switch home-view-switch--desktop" aria-label="首页视图">
        {buttons}
      </nav>
      <details className="home-view-menu home-view-menu--mobile">
        <summary className="home-view-menu__summary">视图</summary>
        <div role="group" aria-label="首页视图">
          {buttons}
        </div>
      </details>
      <span className="sr-only" role="status" aria-live="polite">
        {switching ? `正在切换到${labelFor(current === "classic" ? "waterfall" : "classic")}版` : ""}
      </span>
    </>
  );
}

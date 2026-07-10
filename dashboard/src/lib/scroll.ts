import { shouldReduceMotion } from "./motion.ts";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const NARROW_QUERY = "(max-width: 767px)";

interface ActiveScroll {
  raf: number;
  finish: () => void;
}

const activeScrolls = new WeakMap<object, ActiveScroll>();

export function durationForScroll(distance: number): number {
  const d = Math.abs(distance);
  if (d < 0.5) return 0;
  return Math.round(Math.max(120, Math.min(260, 120 + ((d - 100) * 140) / 900)));
}

export function cancelSmoothScroll(target: object | null): void {
  if (!target) return;
  activeScrolls.get(target)?.finish();
}

function animate(
  key: object,
  getCur: () => number,
  setVal: (y: number) => void,
  target: number,
  requestedDuration?: number,
): Promise<void> {
  const start = getCur();
  const dist = target - start;
  const duration = shouldReduceMotion()
    ? 0
    : requestedDuration ?? durationForScroll(dist);
  cancelSmoothScroll(key);
  if (Math.abs(dist) < 0.5 || duration === 0) {
    setVal(target);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    let raf = 0;
    const inputTarget = key instanceof EventTarget ? key : null;
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      inputTarget?.removeEventListener("wheel", interrupt);
      inputTarget?.removeEventListener("touchstart", interrupt);
      inputTarget?.removeEventListener("pointerdown", interrupt);
      if (activeScrolls.get(key)?.finish === finish) activeScrolls.delete(key);
      resolve();
    };
    const interrupt = () => finish();
    inputTarget?.addEventListener("wheel", interrupt, { passive: true });
    inputTarget?.addEventListener("touchstart", interrupt, { passive: true });
    inputTarget?.addEventListener("pointerdown", interrupt, { passive: true });
    function step(now: number) {
      if (settled) return;
      const t = Math.min(1, (now - t0) / duration);
      setVal(start + dist * easeOut(t));
      if (t < 1) {
        raf = requestAnimationFrame(step);
        activeScrolls.set(key, { raf, finish });
      } else {
        setVal(target);
        finish();
      }
    }
    raf = requestAnimationFrame(step);
    activeScrolls.set(key, { raf, finish });
  });
}

export function smoothScrollToTop(
  el: HTMLElement | null,
  opts: { duration?: number } = {},
): Promise<void> {
  if (!el) return Promise.resolve();
  return animate(
    el,
    () => el.scrollTop,
    (y) => (el.scrollTop = y),
    0,
    opts.duration,
  );
}

export function smoothScrollWindowToTop(
  opts: { duration?: number } = {},
): Promise<void> {
  // R21 架构改造: mobile body fixed 不滚, #root 当 scroll context
  const isNarrow = typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches;
  if (isNarrow) {
    const root = document.getElementById("root");
    if (root) {
      return animate(
        root,
        () => root.scrollTop,
        (y) => (root.scrollTop = y),
        0,
        opts.duration,
      );
    }
  }
  return animate(
    window,
    () => window.scrollY,
    (y) => window.scrollTo(0, y),
    0,
    opts.duration,
  );
}

// Breakpoint-aware: on mobile (single col, page-level scroll), scroll the page;
// on PC (multi-col, per-cell scroll), scroll the given feed body.
export function scrollFeedOrPage(
  feedBody: HTMLElement | null,
  opts: { duration?: number } = {},
): Promise<void> {
  const isNarrow =
    typeof window !== "undefined" &&
    window.matchMedia(NARROW_QUERY).matches;
  if (isNarrow || !feedBody) return smoothScrollWindowToTop(opts);
  return smoothScrollToTop(feedBody, opts);
}

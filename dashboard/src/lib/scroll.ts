const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const DEFAULT_DURATION = 300;
const NARROW_QUERY = "(max-width: 767px)";

function animate(
  getCur: () => number,
  setVal: (y: number) => void,
  target: number,
  duration: number,
): Promise<void> {
  const start = getCur();
  const dist = target - start;
  if (Math.abs(dist) < 0.5) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - t0) / duration);
      setVal(start + dist * easeOut(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

export function smoothScrollToTop(
  el: HTMLElement | null,
  opts: { duration?: number } = {},
): Promise<void> {
  if (!el) return Promise.resolve();
  return animate(
    () => el.scrollTop,
    (y) => (el.scrollTop = y),
    0,
    opts.duration ?? DEFAULT_DURATION,
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
        () => root.scrollTop,
        (y) => (root.scrollTop = y),
        0,
        opts.duration ?? DEFAULT_DURATION,
      );
    }
  }
  return animate(
    () => window.scrollY,
    (y) => window.scrollTo(0, y),
    0,
    opts.duration ?? DEFAULT_DURATION,
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

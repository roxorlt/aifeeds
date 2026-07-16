import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Page-level scroll lock for full-screen overlays (lightbox, modals).
 *
 * Why not just `document.body.style.overflow = "hidden"`?
 *   On mobile (≤767px) the app makes <html>/<body> permanently
 *   `overflow:hidden; height:100vh` (see index.css) and moves the scroll
 *   context to `#root`. So locking <body> is a no-op on mobile — the page
 *   keeps scrolling via #root underneath the overlay. This hook locks the
 *   *actual* scroller:
 *     - mobile  → #root (restore scrollTop on release)
 *     - desktop → <body> overflow:hidden (the wheel-scroll enforcer)
 *
 * Both possible page scrollers are locked for the lifetime of the overlay, so
 * crossing the responsive breakpoint (rotation / split-screen resize) cannot
 * expose a newly active unlocked scroller. A reference-counted target lock
 * makes nested overlays safe even when React cleans them up out of order.
 */
export interface ScrollLockTarget {
  style: { overflow: string };
  scrollTop: number;
}

interface ScrollLockState {
  count: number;
  previousOverflow: string;
  previousScrollTop: number | null;
}

const targetLocks = new WeakMap<object, ScrollLockState>();

export function acquireScrollLock(
  target: ScrollLockTarget,
  restoreScrollTop = false,
): () => void {
  let state = targetLocks.get(target);
  if (!state) {
    state = {
      count: 0,
      previousOverflow: target.style.overflow,
      previousScrollTop: restoreScrollTop ? target.scrollTop : null,
    };
    targetLocks.set(target, state);
  }
  state.count += 1;
  target.style.overflow = "hidden";

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count -= 1;
    if (state.count > 0 || targetLocks.get(target) !== state) return;
    targetLocks.delete(target);
    target.style.overflow = state.previousOverflow;
    if (state.previousScrollTop !== null) target.scrollTop = state.previousScrollTop;
  };
}

export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    const releases = [acquireScrollLock(document.body)];
    const root = document.getElementById("root");
    if (root) releases.push(acquireScrollLock(root, true));

    return () => {
      for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]();
    };
  }, [active]);
}

/**
 * Stop touch-scroll bleed from a full-screen overlay into the scrollable
 * ancestor underneath (drawer body / #root / feed).
 *
 * On iOS WKWebView and WeChat's X5 webview, `overscroll-behavior` and
 * `touch-action` do NOT reliably stop the underlying scroll from a fixed
 * overlay (WebKit bug 133112 — already noted in App.tsx / Feed.tsx). The
 * proven enforcer in this codebase is a non-passive `touchmove` +
 * `preventDefault`. We also stopPropagation on the touch sequence so the
 * overlay's gestures never reach ancestor native handlers (the drawer's
 * swipe-to-close on <aside>, the drawer-body boundary nudge, the app-level
 * tab-swipe / pull-to-refresh) — otherwise a swipe on the open lightbox could
 * drag the drawer panel or trigger a channel switch.
 *
 * Passes through:
 *   - multi-touch (so pinch-zoom keeps working if it's ever enabled)
 *   - touches inside an element matching `allowSelector` (default "video", so
 *     the lightbox video's scrubber / volume controls stay draggable)
 */
export function useTouchScrollGuard<T extends HTMLElement>(
  ref: RefObject<T | null>,
  allowSelector = "video",
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const stop = (e: TouchEvent) => e.stopPropagation();
    const onMove = (e: TouchEvent) => {
      e.stopPropagation();
      if (e.touches.length > 1) return; // let pinch / multi-touch through
      const t = e.target as HTMLElement | null;
      if (t && allowSelector && t.closest(allowSelector)) return; // video etc.
      if (e.cancelable) e.preventDefault();
    };

    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", stop, { passive: true });
    el.addEventListener("touchcancel", stop, { passive: true });
    return () => {
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", stop);
      el.removeEventListener("touchcancel", stop);
    };
  }, [ref, allowSelector]);
}

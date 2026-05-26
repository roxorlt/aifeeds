// R21: mobile body-fixed 架构改造 — body 不滚, #root 当 scroll context.
// 这是为了根治 iOS Safari pull-to-refresh (body 不滚 → 浏览器没东西可下拉).
// PC 仍走 window scroll (多 column + cell-level scroll 不需要改).
//
// 用法:
//   import { getScrollY, scrollRootTo, addScrollRootListener } from '@/lib/scrollRoot';
//   const y = getScrollY();           // 替代 window.scrollY
//   scrollRootTo(0, 100);              // 替代 window.scrollTo
//   const off = addScrollRootListener(handler); off(); // listener
//
// mobile 时返回 #root scroll, PC 时返回 window scroll, 调用方无需关心.

const NARROW_QUERY = "(max-width: 767px)";

function isNarrow(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

function getRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById("root");
}

/** 当前 scroll Y 位置. mobile: #root.scrollTop, PC: window.scrollY */
export function getScrollY(): number {
  if (isNarrow()) {
    const root = getRoot();
    if (root) return root.scrollTop;
  }
  return window.scrollY;
}

/** 滚到指定位置. */
export function scrollRootTo(x: number, y: number): void {
  if (isNarrow()) {
    const root = getRoot();
    if (root) {
      root.scrollTo(x, y);
      return;
    }
  }
  window.scrollTo(x, y);
}

/** 监听 scroll 事件. 返回 unsubscribe 函数. */
export function addScrollRootListener(
  handler: (e: Event) => void,
  options?: AddEventListenerOptions,
): () => void {
  const opts = options ?? { passive: true };
  if (isNarrow()) {
    const root = getRoot();
    if (root) {
      root.addEventListener("scroll", handler, opts);
      return () => root.removeEventListener("scroll", handler);
    }
  }
  window.addEventListener("scroll", handler, opts);
  return () => window.removeEventListener("scroll", handler);
}

/** 给 IntersectionObserver / 其他 API 当 root 用. mobile 是 #root, PC 是 null (=viewport) */
export function getIntersectionRoot(): HTMLElement | null {
  if (isNarrow()) {
    return getRoot();
  }
  return null;
}

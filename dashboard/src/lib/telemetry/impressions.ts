// 卡片曝光埋点辅助 — IntersectionObserver
// 规则：
//   - 进入视口 ≥ 1s 才算 impression（防滚动飞掠误报）
//   - 同一 element 在同一会话只算一次

import { useEffect, useRef } from 'react';

const MIN_VISIBLE_MS = 1_000;
const VISIBLE_THRESHOLD = 0.5;  // 50% 进入视口才算可见

interface PendingObservation {
  element: Element;
  enteredAt: number;
  fired: boolean;
}

const pending = new WeakMap<Element, PendingObservation>();

let observer: IntersectionObserver | null = null;
let onImpressionCallback: ((el: Element) => void) | null = null;

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      const now = Date.now();
      for (const entry of entries) {
        const state = pending.get(entry.target);
        if (!state) continue;
        if (state.fired) continue;

        if (entry.isIntersecting) {
          state.enteredAt = now;
          // 1s 后检查是否还在视口里
          setTimeout(() => {
            if (!state.fired && pending.get(entry.target) === state) {
              const stillIn = entry.target.getBoundingClientRect();
              const inViewport =
                stillIn.top < window.innerHeight && stillIn.bottom > 0;
              if (inViewport && Date.now() - state.enteredAt >= MIN_VISIBLE_MS) {
                state.fired = true;
                onImpressionCallback?.(entry.target);
              }
            }
          }, MIN_VISIBLE_MS);
        }
      }
    },
    { threshold: VISIBLE_THRESHOLD },
  );
  return observer;
}

export function setImpressionHandler(handler: (el: Element) => void): void {
  onImpressionCallback = handler;
}

/**
 * React hook — 监听 element 曝光。
 * 用法：
 *   const ref = useImpression(() => track(EVENTS.ITEM_IMPRESSION, { item_id }));
 *   return <article ref={ref}>...</article>;
 */
export function useImpression(onFire: () => void): React.RefCallback<Element> {
  const firedRef = useRef(false);
  const elRef = useRef<Element | null>(null);

  useEffect(() => {
    const ob = ensureObserver();
    return () => {
      if (elRef.current) ob.unobserve(elRef.current);
    };
  }, []);

  return (node) => {
    if (!node) {
      if (elRef.current) {
        ensureObserver().unobserve(elRef.current);
        pending.delete(elRef.current);
        elRef.current = null;
      }
      return;
    }
    if (elRef.current === node) return;
    if (firedRef.current) return;

    elRef.current = node;
    pending.set(node, {
      element: node,
      enteredAt: 0,
      fired: false,
    });
    setImpressionHandler((el) => {
      if (el === node && !firedRef.current) {
        firedRef.current = true;
        onFire();
      }
    });
    ensureObserver().observe(node);
  };
}

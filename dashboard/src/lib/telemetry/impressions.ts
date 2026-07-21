// 卡片曝光埋点辅助 — IntersectionObserver
// 规则：
//   - 进入视口 ≥ 1s 才算 impression（防滚动飞掠误报）
//   - 同一 element 在同一会话只算一次

import { useCallback, useEffect, useRef } from 'react';

const MIN_VISIBLE_MS = 1_000;
const VISIBLE_THRESHOLD = 0.5;  // 50% 进入视口才算可见

interface PendingObservation {
  element: Element;
  enteredAt: number;
  fired: boolean;
  visible: boolean;
  visibilityCycle: number;
  onFire: () => void;
}

const pending = new WeakMap<Element, PendingObservation>();

let observer: IntersectionObserver | null = null;

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      const now = Date.now();
      for (const entry of entries) {
        const state = pending.get(entry.target);
        if (!state) continue;
        if (state.fired) continue;

        const sufficientlyVisible =
          entry.isIntersecting && entry.intersectionRatio >= VISIBLE_THRESHOLD;
        if (!sufficientlyVisible) {
          state.visible = false;
          state.enteredAt = 0;
          state.visibilityCycle += 1;
          continue;
        }

        if (!state.visible) {
          state.visible = true;
          state.enteredAt = now;
          const visibilityCycle = state.visibilityCycle;
          // 1s 后检查是否还在视口里
          setTimeout(() => {
            if (
              !state.fired
              && state.visible
              && state.visibilityCycle === visibilityCycle
              && pending.get(entry.target) === state
            ) {
              const stillIn = entry.target.getBoundingClientRect();
              const inViewport =
                stillIn.top < window.innerHeight && stillIn.bottom > 0;
              if (inViewport && Date.now() - state.enteredAt >= MIN_VISIBLE_MS) {
                state.fired = true;
                state.onFire();
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

export function observeImpression(element: Element, onFire: () => void): () => void {
  const state: PendingObservation = {
    element,
    enteredAt: 0,
    fired: false,
    visible: false,
    visibilityCycle: 0,
    onFire,
  };
  pending.set(element, state);
  const impressionObserver = ensureObserver();
  impressionObserver.observe(element);

  return () => {
    impressionObserver.unobserve(element);
    if (pending.get(element) === state) {
      pending.delete(element);
    }
  };
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
  const onFireRef = useRef(onFire);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  useEffect(() => () => {
    stopRef.current?.();
    stopRef.current = null;
    elRef.current = null;
  }, []);

  return useCallback((node) => {
    if (!node) {
      stopRef.current?.();
      stopRef.current = null;
      elRef.current = null;
      return;
    }
    if (elRef.current === node) return;
    if (firedRef.current) return;

    stopRef.current?.();
    elRef.current = node;
    stopRef.current = observeImpression(node, () => {
      if (!firedRef.current) {
        firedRef.current = true;
        onFireRef.current();
      }
    });
  }, []);
}

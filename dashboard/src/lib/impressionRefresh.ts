// 卡片进入视口 ≥ 500ms 触发 POST /api/items/:id/refresh —— "fire-and-forget"
// 弱触发, 让用户翻到哪条数据就保鲜哪条 (refresh-tiered cron 兜底覆盖, 但 cold
// item 排队靠后, 用户主动浏览的可立即拉新).
//
// 跟 lib/telemetry/impressions.ts 的设计差异:
//   - 那个是 "oneShot" (一次会话一次曝光埋点), 防滚动飞掠
//   - 这个是 "每次进视口都重新触发", 用户滚走滚回需要再保鲜
//   - 防抖:进视口 < 500ms 离开则不触发
//   - 节流由 worker 端 KV 兜底 (5min 内同 item 重复请求 silent return throttled)
//   - 失败 silent catch, 不上报埋点 (污染数据)
//
// 全局共享一个 IntersectionObserver 实例, N 张卡共享 (性能).

import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "../api";

const VISIBLE_THRESHOLD = 0.5;
const MIN_VISIBLE_MS = 500;

interface PendingEntry {
  itemId: string;
  timer: number | null;
}

const pending = new WeakMap<Element, PendingEntry>();

let observer: IntersectionObserver | null = null;

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const state = pending.get(entry.target);
        if (!state) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_THRESHOLD) {
          if (state.timer != null) window.clearTimeout(state.timer);
          state.timer = window.setTimeout(() => {
            state.timer = null;
            void fireRefresh(state.itemId);
          }, MIN_VISIBLE_MS);
        } else {
          if (state.timer != null) {
            window.clearTimeout(state.timer);
            state.timer = null;
          }
        }
      }
    },
    { threshold: VISIBLE_THRESHOLD },
  );
  return observer;
}

async function fireRefresh(itemId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/items/${itemId}/refresh`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // silent — fire-and-forget; worker throttle 兜底, 失败 (网络抖动 / 401) 不影响体验
  }
}

/**
 * 卡片 root element 挂这个 ref → 进入视口 ≥ 500ms 触发 refresh.
 * 用法:
 *   const refreshRef = useImpressionRefresh(item.id);
 *   return <article ref={refreshRef}>...</article>;
 *
 * 跟 useImpression 共用同一 element 时, 用 mergeRefs(impressionRef, refreshRef).
 */
export function useImpressionRefresh(
  itemId: string | null | undefined,
): React.RefCallback<Element> {
  const elRef = useRef<Element | null>(null);
  const itemIdRef = useRef<string | null | undefined>(itemId);
  itemIdRef.current = itemId;

  useEffect(() => {
    return () => {
      const el = elRef.current;
      if (el) {
        const state = pending.get(el);
        if (state?.timer != null) window.clearTimeout(state.timer);
        pending.delete(el);
        ensureObserver().unobserve(el);
        elRef.current = null;
      }
    };
  }, []);

  return useCallback((node) => {
    if (!node) {
      const el = elRef.current;
      if (el) {
        const state = pending.get(el);
        if (state?.timer != null) window.clearTimeout(state.timer);
        pending.delete(el);
        ensureObserver().unobserve(el);
        elRef.current = null;
      }
      return;
    }
    // itemId 为空时不挂 observer (caller 用 disabled 语义关闭, 比如 embedded 卡片)
    if (!itemIdRef.current) return;
    if (elRef.current === node) return;
    elRef.current = node;
    pending.set(node, { itemId: itemIdRef.current, timer: null });
    ensureObserver().observe(node);
  }, []);
}

/**
 * 合并多个 ref callback / ref object → 一个 ref callback.
 * 用于一个 element 上同时挂多个 hook 返回的 ref (如 useImpression + useImpressionRefresh).
 */
export function mergeRefs<T>(
  ...refs: Array<React.Ref<T> | undefined>
): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref && typeof ref === "object" && "current" in ref) {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    }
  };
}

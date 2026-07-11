// 卡片进入视口 ≥ 5000ms 触发 POST /api/items/:id/refresh —— "fire-and-forget"
// 弱触发, 让用户翻到哪条数据就保鲜哪条 (refresh-tiered cron 兜底覆盖, 但 cold
// item 排队靠后, 用户主动浏览的可立即拉新).
//
// 跟 lib/telemetry/impressions.ts 的设计差异:
//   - 那个是 "oneShot" (一次会话一次曝光埋点), 防滚动飞掠
//   - 这个是 "每次进视口都重新评估", 用户滚走滚回需要再保鲜
//   - 防抖:5s 内离开视口则不触发 (PM 5/28 反馈: 只精读才该触发, 不该扫读触发)
//   - 客户端 5min sessionStorage 缓存: 同 item 在 5min 内已 fire 过就直接 skip,
//     连 worker 都不打 (省 KV read 跟 worker request, 缓解 ScrapeBadger 计费爆炸)
//   - 服务端 5min KV throttle 兜底 (跨标签 / 跨设备同 item 重复请求会被挡)
//   - 服务端全局开关 (KV flag:impression_refresh): off 时 worker 直接返 disabled,
//     FE 不感知 — 出 prod 事故秒切 (admin /admin/tools UI 切)
//   - 失败 silent catch, 不上报埋点 (污染数据)
//
// 全局共享一个 IntersectionObserver 实例, N 张卡共享 (性能).

import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "../api";
import {
  updateObservedImpressionElement,
  type ImpressionElementRef,
} from "./impressionElementLifecycle";

const VISIBLE_THRESHOLD = 0.7;
const MIN_VISIBLE_MS = 5000;
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;  // 5min, 跟服务端 KV TTL 对齐
const CACHE_KEY_PREFIX = "refresh:";

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

// 客户端 5min sessionStorage 缓存 — 避免同一 item 在短时间内多次发请求
// (用户滚走滚回 / 多 column 模式下同 item 出现在不同位置 / 等). sessionStorage
// 选 over localStorage 因为 metrics 保鲜是会话级需求, 新会话用户希望拿新数据.
function shouldSkipFromCache(itemId: string): boolean {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + itemId);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < CLIENT_CACHE_TTL_MS;
  } catch {
    return false;  // sessionStorage 不可用 (incognito iOS Safari) 不缓存
  }
}

function markCacheFired(itemId: string): void {
  try {
    sessionStorage.setItem(CACHE_KEY_PREFIX + itemId, String(Date.now()));
  } catch {
    // sessionStorage 不可用 → 走服务端 KV throttle 兜底
  }
}

async function fireRefresh(itemId: string): Promise<void> {
  if (shouldSkipFromCache(itemId)) return;
  markCacheFired(itemId);
  try {
    // ?trigger=impression 区分调用源 — worker 端只对 impression 检查 feature flag
    // (drawer 打开 / 海报触发 走同一 endpoint 但不带 trigger param, 不受 flag 影响,
    // 它俩是 user-initiated 强需求, 不该跟 ScrapeBadger 计费保护 mute 在一起)
    await fetch(`${API_BASE}/api/items/${itemId}/refresh?trigger=impression`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // silent — fire-and-forget; worker throttle 兜底, 失败 (网络抖动 / 401) 不影响体验
  }
}

/**
 * Owns one card element's observer registration. React calls the old ref with
 * null before calling the new itemId-bound ref with the same node, so an item
 * identity change cancels the old dwell timer before starting a fresh one.
 */
export function updateImpressionElement(
  node: Element | null,
  itemId: string | null | undefined,
  elRef: ImpressionElementRef,
): void {
  updateObservedImpressionElement(node, itemId, elRef, {
    pending,
    observe: (element) => ensureObserver().observe(element),
    unobserve: (element) => observer?.unobserve(element),
    clearTimer: (timer) => window.clearTimeout(timer),
  });
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

  useEffect(() => {
    return () => {
      updateImpressionElement(null, null, elRef);
    };
  }, []);

  return useCallback(
    (node) => updateImpressionElement(node, itemId, elRef),
    [itemId],
  );
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

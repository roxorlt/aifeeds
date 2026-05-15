// VideoCoordinator —— 中心化全局视频播放协调器（B 重构）。
//
// 设计文档：docs/plans/2026-05-15-video-playback-coordinator-design.md
// 重构原因（review 2026-05-15）：第一版分布式架构（每个 video hook 自己跑
// IO + scroll + 写 store）出现多重 race（mode 切换跟 visibility 写入时序错位、
// 抽屉打开 / 关闭后 stale 状态等）。此版改为：
//
//   - 中心 store 持有所有 video element refs + 每个 column 的 scroll root
//   - 每个 root 一个统一 scroll listener（RAF throttle），任何信号变化都跑
//     同一个 recompute() 入口
//   - recompute() 读 live DOM bbox（不依赖 store 里的 stale top 字段），算
//     hot zone 命中 + 优先级 → 选 activeId → broadcast
//   - video 组件零决策：只 register el / subscribe activeId / play+pause
//
// telemetry：dev console log（import.meta.env.DEV）追踪 register / mode-change /
// recompute / pick 等关键事件，方便我自己跑 playwright 验证。

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type VideoMode = "feed" | "drawer" | "hidden";

interface VideoCandidate {
  el: HTMLVideoElement;
  columnId: string;
  userPaused: boolean;
}

interface ColumnRoot {
  /** scroll container element；null = 跟 viewport 关联 */
  el: HTMLElement | null;
  hotZoneRatio: number;
}

export interface VideoPrefs {
  autoplay: boolean;
  muted: boolean;
}

const DEFAULT_PREFS: VideoPrefs = { autoplay: true, muted: true };

interface VideoCoordinatorState {
  // ─── live state ──────────────────────────────────────────
  videos: Map<string, VideoCandidate>;
  columnRoots: Map<string, ColumnRoot>;
  columnOrder: string[];
  mode: VideoMode;
  lastClickedColumnId: string | null;
  globalMuted: boolean;
  prefs: VideoPrefs;
  /** 输出：当前应播的 videoId（subscriber 用 selector 监听） */
  activeId: string | null;

  // ─── actions（外部调用） ─────────────────────────────────
  register: (videoId: string, el: HTMLVideoElement, columnId: string) => void;
  unregister: (videoId: string) => void;
  setColumnRoot: (columnId: string, el: HTMLElement | null, hotZoneRatio: number) => void;
  setColumnOrder: (order: string[]) => void;
  setMode: (mode: VideoMode) => void;
  markColumnClick: (columnId: string) => void;
  markUserPaused: (videoId: string, paused: boolean) => void;
  setGlobalMuted: (muted: boolean) => void;
  setPrefs: (patch: Partial<VideoPrefs>) => void;

  // ─── 内部唯一决策入口 ────────────────────────────────────
  recompute: () => void;
}

// ─── 工具函数 ─────────────────────────────────────────────

function viewportRect(): DOMRectReadOnly {
  return {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  } as DOMRectReadOnly;
}

/**
 * hot zone 命中判断 —— 使用"视频中心点在 hot zone 内"作为唯一判定（loose）。
 *
 * 历史：v1 用"完整在 hot zone 内"严格判定，但 video 高 ~144 hot zone 高 ~231
 * 时滑动 50px 就出严格判定 → 即使视觉中心仍在中央也判暂停（review bug 1）。
 * loose 判定保证：
 *   - first mount 视频在中部 → 立即起播（review bug 3）
 *   - 滑动 ±(hotZone.h/2 - video.h/2) 范围内 active 不变（消除边界抖动）
 *   - 视频比 hot zone 大（未来竖版长视频）天然兼容
 */
function inHotZone(target: DOMRect, root: DOMRectReadOnly, ratio: number): boolean {
  const hotH = root.height * ratio;
  const hotTop = root.top + (root.height - hotH) / 2;
  const hotBottom = hotTop + hotH;
  const center = target.top + target.height / 2;
  return center >= hotTop && center <= hotBottom;
}

const isDev = (() => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
})();

function log(event: string, payload?: Record<string, unknown>): void {
  if (!isDev) return;
  // 编码到一行，方便 console 抓取
  const safe = payload ? JSON.stringify(payload) : "";
  // eslint-disable-next-line no-console
  console.log(`[VC] ${event} ${safe}`);
}

// ─── store ────────────────────────────────────────────────

export const useVideoCoordinator = create<VideoCoordinatorState>()(
  persist(
    (set, get) => ({
      videos: new Map(),
      columnRoots: new Map(),
      columnOrder: [],
      mode: "feed",
      lastClickedColumnId: null,
      globalMuted: true,
      prefs: DEFAULT_PREFS,
      activeId: null,

      register: (videoId, el, columnId) => {
        const next = new Map(get().videos);
        const existing = next.get(videoId);
        next.set(videoId, {
          el,
          columnId,
          userPaused: existing?.userPaused ?? false,
        });
        set({ videos: next });
        log("register", { videoId, columnId, total: next.size });
        get().recompute();
      },

      unregister: (videoId) => {
        const next = new Map(get().videos);
        if (!next.delete(videoId)) return;
        set({ videos: next });
        log("unregister", { videoId, total: next.size });
        if (get().activeId === videoId) set({ activeId: null });
        get().recompute();
      },

      setColumnRoot: (columnId, el, hotZoneRatio) => {
        // 清旧 listener / attach 新
        const cleanups = listenerRegistry.get(columnId);
        if (cleanups) {
          cleanups();
          listenerRegistry.delete(columnId);
        }

        const next = new Map(get().columnRoots);
        if (el) {
          next.set(columnId, { el, hotZoneRatio });
          attachScrollListener(columnId, el);
        } else {
          next.delete(columnId);
        }
        set({ columnRoots: next });
        log("setColumnRoot", { columnId, hasEl: !!el, hotZoneRatio });
        get().recompute();
      },

      setColumnOrder: (order) => {
        set({ columnOrder: order });
        get().recompute();
      },

      setMode: (mode) => {
        if (get().mode === mode) return;
        const from = get().mode;
        set({ mode });
        log("setMode", { from, to: mode });
        get().recompute();
      },

      markColumnClick: (columnId) => {
        if (get().lastClickedColumnId === columnId) return;
        set({ lastClickedColumnId: columnId });
        log("markColumnClick", { columnId });
        get().recompute();
      },

      markUserPaused: (videoId, paused) => {
        const next = new Map(get().videos);
        const c = next.get(videoId);
        if (!c || c.userPaused === paused) return;
        next.set(videoId, { ...c, userPaused: paused });
        set({ videos: next });
        log("markUserPaused", { videoId, paused });
        get().recompute();
      },

      setGlobalMuted: (muted) => {
        set({ globalMuted: muted });
        log("setGlobalMuted", { muted });
        // mute 不影响 active 选取，不需要 recompute
      },

      setPrefs: (patch) => {
        set((s) => ({ prefs: { ...s.prefs, ...patch } }));
        if (patch.muted !== undefined) set({ globalMuted: patch.muted });
        log("setPrefs", patch);
        get().recompute();
      },

      recompute: () => {
        const s = get();
        // 关闭 autoplay → activeId 强制 null
        if (!s.prefs.autoplay) {
          if (s.activeId !== null) {
            set({ activeId: null });
            log("pick", { mode: s.mode, picked: null, reason: "autoplay-off" });
          }
          return;
        }
        if (s.mode === "hidden") {
          if (s.activeId !== null) {
            set({ activeId: null });
            log("pick", { mode: s.mode, picked: null, reason: "tab-hidden" });
          }
          return;
        }

        // 收集 eligible candidates（live bbox + hot zone 判定）
        const eligible: Array<{ id: string; columnId: string; top: number }> = [];
        for (const [id, c] of s.videos) {
          if (c.userPaused) continue;
          if (s.mode === "drawer" && c.columnId !== "drawer") continue;
          if (s.mode === "feed" && c.columnId === "drawer") continue;

          const colRoot = s.columnRoots.get(c.columnId);
          // 没注册 root 视为可见性退化到 viewport
          const rootRect = colRoot?.el ? colRoot.el.getBoundingClientRect() : viewportRect();
          const ratio = colRoot?.hotZoneRatio ?? 0.5;
          const targetRect = c.el.getBoundingClientRect();

          if (inHotZone(targetRect, rootRect, ratio)) {
            eligible.push({ id, columnId: c.columnId, top: targetRect.top });
          }
        }

        if (eligible.length === 0) {
          if (s.activeId !== null) {
            set({ activeId: null });
            log("pick", { mode: s.mode, picked: null, reason: "no-eligible" });
          }
          return;
        }

        // 跨列优先级
        let preferredCol: string | null = null;
        if (s.mode === "drawer") {
          preferredCol = "drawer";
        } else if (
          s.lastClickedColumnId &&
          eligible.some((e) => e.columnId === s.lastClickedColumnId)
        ) {
          preferredCol = s.lastClickedColumnId;
        } else {
          for (const col of s.columnOrder) {
            if (eligible.some((e) => e.columnId === col)) {
              preferredCol = col;
              break;
            }
          }
          if (!preferredCol) preferredCol = eligible[0].columnId;
        }

        // 列内取 top 最小
        const inCol = eligible.filter((e) => e.columnId === preferredCol);
        inCol.sort((a, b) => a.top - b.top);
        const picked = inCol[0]?.id ?? null;

        if (picked !== s.activeId) {
          set({ activeId: picked });
          log("pick", {
            mode: s.mode,
            picked,
            preferredCol,
            eligibleCount: eligible.length,
            lastClicked: s.lastClickedColumnId,
          });
        }
      },
    }),
    {
      name: "ai-feeds-video-prefs",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ prefs: s.prefs }),
    },
  ),
);

// ─── scroll listener 注册表（外部 module-level）──────────────
// 每个 columnRoot 一个 listener，setColumnRoot 时增删。
const listenerRegistry = new Map<string, () => void>();

function attachScrollListener(columnId: string, el: HTMLElement): void {
  let rafId: number | null = null;
  const onScroll = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      useVideoCoordinator.getState().recompute();
    });
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  listenerRegistry.set(columnId, () => {
    el.removeEventListener("scroll", onScroll);
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
  log("attachScrollListener", { columnId });
}

// ─── 全局 listeners（mount 一次） ─────────────────────────

let globalAttached = false;

/** App.tsx 顶层调一次：window scroll + visibilitychange + window resize */
export function attachGlobalVideoListeners(): () => void {
  if (globalAttached) return () => {};
  globalAttached = true;

  let rafId: number | null = null;
  const onWindowScroll = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      useVideoCoordinator.getState().recompute();
    });
  };
  window.addEventListener("scroll", onWindowScroll, { passive: true });
  window.addEventListener("resize", onWindowScroll, { passive: true });

  const onVis = () => {
    if (document.hidden) {
      useVideoCoordinator.getState().setMode("hidden");
    } else {
      useVideoCoordinator.getState().setMode("feed");
    }
  };
  document.addEventListener("visibilitychange", onVis);

  return () => {
    window.removeEventListener("scroll", onWindowScroll);
    window.removeEventListener("resize", onWindowScroll);
    document.removeEventListener("visibilitychange", onVis);
    if (rafId !== null) cancelAnimationFrame(rafId);
    globalAttached = false;
  };
}

// 老 export 名兼容（attachVisibilityListener）— 保留让 App.tsx 引用不破
export const attachVisibilityListener = attachGlobalVideoListeners;

// dev 环境暴露 store 到 window.__VC 给 playwright 自测用；prod 不暴露
if (isDev && typeof window !== "undefined") {
  (window as unknown as { __VC?: unknown }).__VC = useVideoCoordinator;
}

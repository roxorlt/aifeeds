// VideoCoordinator — 全局单视频播放协调器。
//
// 详见设计文档：docs/plans/2026-05-15-video-playback-coordinator-design.md
//
// 核心规则（v1）：
// - 视频 ≥ 67% 可见 + 持续 ≥ 200ms → 候选
// - 同列多候选取最上面
// - 跨列 → 最近 click 过的列优先；都没 click → 从左到右、从上到下
// - 抽屉打开期间，feed 视频全停；抽屉内独立轮换
// - 用户主动暂停 sticky；用户 unmute 全局 sticky
// - 切 tab / 浏览器 hidden → 全停
//
// candidates 是运行态（不持久化）；prefs（autoplay / muted）持久化到 localStorage。

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type VideoMode = "feed" | "drawer" | "hidden";

interface VideoCandidate {
  /** 列 / context id：feed 列用 source_type，抽屉用 'drawer' */
  columnId: string;
  /** 0..1，最近一次 IntersectionObserver 报告的可见比例 */
  visibleRatio: number;
  /** ≥ 67% 持续 ≥ 200ms 后由 hook 置 true */
  isVisible: boolean;
  /** video element 当前 viewport top（每次可见性变化由 hook 顺带更新）。
   *  优先级算法用它做"同列取最上"决策。 */
  top: number;
  /** 用户主动暂停过 → 本 session 不再被自动播 */
  userPaused: boolean;
}

export interface VideoPrefs {
  /** 关掉则所有视频都不自动播，只显示首帧 */
  autoplay: boolean;
  /** 默认静音播放（浏览器 autoplay policy 要求） */
  muted: boolean;
}

interface VideoCoordinatorState {
  candidates: Map<string, VideoCandidate>;
  activeId: string | null;
  mode: VideoMode;
  /** PC 多列时记录最近被 click 的列，用于跨列优先级 */
  lastClickedColumnId: string | null;
  /** 用户在某视频 unmute 后 sticky 到 session 结束 */
  globalMuted: boolean;
  /** 列在 DOM 中从左到右的顺序，由 App.tsx 写入 */
  columnOrder: string[];
  prefs: VideoPrefs;

  // ─── actions ──────────────────────────────────────────────
  register: (videoId: string, columnId: string) => void;
  unregister: (videoId: string) => void;
  setVisibility: (videoId: string, ratio: number, isVisible: boolean, top: number) => void;
  markUserPaused: (videoId: string, paused: boolean) => void;
  markColumnClick: (columnId: string) => void;
  setMode: (mode: VideoMode) => void;
  setGlobalMuted: (muted: boolean) => void;
  setColumnOrder: (order: string[]) => void;
  setPrefs: (patch: Partial<VideoPrefs>) => void;
  /** 内部：根据当前 candidates / mode / 优先级算出 active id */
  selectActive: () => void;
}

const DEFAULT_PREFS: VideoPrefs = {
  autoplay: true,
  muted: true,
};

/**
 * 优先级算法 — 按设计文档 §2.2：
 *   feed mode：
 *     1. 同列内 → 最上的（domOrder 最小）
 *     2. 跨列 → 最近 click 过的列优先；都没 → 按 columnOrder 从左到右
 *   drawer mode：
 *     仅考虑 columnId === 'drawer' 的候选；同样取最上的
 *   hidden mode：
 *     active = null
 */
function computeActive(
  candidates: Map<string, VideoCandidate>,
  mode: VideoMode,
  lastClickedColumnId: string | null,
  columnOrder: string[],
): string | null {
  if (mode === "hidden") return null;

  // 收集所有 isVisible && !userPaused 的候选
  const eligible: Array<[string, VideoCandidate]> = [];
  for (const [id, c] of candidates) {
    if (!c.isVisible || c.userPaused) continue;
    if (mode === "drawer" && c.columnId !== "drawer") continue;
    if (mode === "feed" && c.columnId === "drawer") continue;
    eligible.push([id, c]);
  }
  if (eligible.length === 0) return null;

  // 按列分组
  const byColumn = new Map<string, Array<[string, VideoCandidate]>>();
  for (const entry of eligible) {
    const col = entry[1].columnId;
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)!.push(entry);
  }

  // 决定优先列：
  // - drawer mode 只有一个 'drawer' 列
  // - feed mode 优先 lastClickedColumnId（如该列还有候选）
  // - 否则按 columnOrder
  let preferredCol: string | null = null;
  if (mode === "drawer") {
    preferredCol = "drawer";
  } else if (lastClickedColumnId && byColumn.has(lastClickedColumnId)) {
    preferredCol = lastClickedColumnId;
  } else {
    for (const col of columnOrder) {
      if (byColumn.has(col)) {
        preferredCol = col;
        break;
      }
    }
    // 兜底：columnOrder 没覆盖到的列，取 byColumn 第一个 key
    if (!preferredCol) preferredCol = byColumn.keys().next().value ?? null;
  }
  if (!preferredCol) return null;

  // 优先列内取 top 最小的（最靠 viewport 上方）
  const inCol = byColumn.get(preferredCol)!;
  inCol.sort((a, b) => a[1].top - b[1].top);
  return inCol[0][0];
}

export const useVideoCoordinator = create<VideoCoordinatorState>()(
  persist(
    (set, get) => ({
      candidates: new Map(),
      activeId: null,
      mode: "feed",
      lastClickedColumnId: null,
      globalMuted: true,
      columnOrder: [],
      prefs: DEFAULT_PREFS,

      register: (videoId, columnId) => {
        set((state) => {
          const next = new Map(state.candidates);
          const existing = next.get(videoId);
          next.set(videoId, {
            columnId,
            top: existing?.top ?? Infinity,
            visibleRatio: existing?.visibleRatio ?? 0,
            isVisible: existing?.isVisible ?? false,
            userPaused: existing?.userPaused ?? false,
          });
          return { candidates: next };
        });
        get().selectActive();
      },

      unregister: (videoId) => {
        set((state) => {
          if (!state.candidates.has(videoId)) return state;
          const next = new Map(state.candidates);
          next.delete(videoId);
          const nextActive = state.activeId === videoId ? null : state.activeId;
          return { candidates: next, activeId: nextActive };
        });
        get().selectActive();
      },

      setVisibility: (videoId, ratio, isVisible, top) => {
        set((state) => {
          const c = state.candidates.get(videoId);
          if (!c) return state;
          if (c.visibleRatio === ratio && c.isVisible === isVisible && c.top === top) return state;
          const next = new Map(state.candidates);
          next.set(videoId, { ...c, visibleRatio: ratio, isVisible, top });
          return { candidates: next };
        });
        get().selectActive();
      },

      markUserPaused: (videoId, paused) => {
        set((state) => {
          const c = state.candidates.get(videoId);
          if (!c) return state;
          const next = new Map(state.candidates);
          next.set(videoId, { ...c, userPaused: paused });
          return { candidates: next };
        });
        get().selectActive();
      },

      markColumnClick: (columnId) => {
        if (get().lastClickedColumnId === columnId) return;
        set({ lastClickedColumnId: columnId });
        get().selectActive();
      },

      setMode: (mode) => {
        if (get().mode === mode) return;
        set({ mode });
        get().selectActive();
      },

      setGlobalMuted: (muted) => {
        set({ globalMuted: muted });
      },

      setColumnOrder: (order) => {
        set({ columnOrder: order });
        get().selectActive();
      },

      setPrefs: (patch) => {
        set((state) => ({ prefs: { ...state.prefs, ...patch } }));
        // muted pref 改变时同步 globalMuted（用户调设置 = 主动意图）
        if (patch.muted !== undefined) set({ globalMuted: patch.muted });
        get().selectActive();
      },

      selectActive: () => {
        const s = get();
        // autoplay pref 关 → 永不自动选 active（视频显示 thumbnail + 手动 play）
        if (!s.prefs.autoplay) {
          if (s.activeId !== null) set({ activeId: null });
          return;
        }
        const next = computeActive(
          s.candidates,
          s.mode,
          s.lastClickedColumnId,
          s.columnOrder,
        );
        if (next !== s.activeId) set({ activeId: next });
      },
    }),
    {
      name: "ai-feeds-video-prefs",
      storage: createJSONStorage(() => localStorage),
      // 只持久化 prefs；运行态（candidates / activeId / mode / globalMuted 等）不写盘
      partialize: (s) => ({ prefs: s.prefs }),
    },
  ),
);

/**
 * 顶层挂载一次：监听 document.visibilitychange，hidden 时全停。
 * 由 App.tsx 调用，返回 cleanup 函数。
 */
export function attachVisibilityListener(): () => void {
  const onChange = () => {
    if (document.hidden) {
      useVideoCoordinator.getState().setMode("hidden");
    } else {
      // 不直接恢复 'feed' — 由抽屉状态决定（drawer 同步会更新 mode）
      // 这里恢复 feed 是兜底；如果抽屉是开的，drawer 同步会立即覆盖
      useVideoCoordinator.getState().setMode("feed");
    }
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

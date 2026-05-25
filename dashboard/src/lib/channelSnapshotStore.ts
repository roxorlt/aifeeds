// Channel transition snapshot store — PM 2026-05-25 R10
// 每个 channel (sourceType) 维持一张 viewport 快照 (PNG dataUri),用于
// 频道切换 transition 期间显示, 避免目标 tab mount 前的"空白帧"。
//
// 更新时机 (Feed 组件内自动调):
//   - 该 channel 首次 fetch 完成
//   - 该 channel scroll 停下来 (debounce 300ms)
//   - drawer 关闭返回 channel feed
//   - 切到其他 tab 之前 (做"出场快照")
//
// 失效:5 分钟 TTL,过期回 skeleton (而非显 stale 快照).
// 跨 tab 互不影响 (Map by sourceType).

import { create } from "zustand";

export interface ChannelSnapshot {
  dataUri: string;     // PNG data URL (modern-screenshot 输出)
  capturedAt: number;  // Date.now() 时间戳
}

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

interface ChannelSnapshotStore {
  // 内部 store 不直接 export Map (immutability 友好), 用 record obj
  snapshots: Record<string, ChannelSnapshot>;
  /** 写入快照 (覆盖同 channel 老快照, 不累加) */
  setSnapshot: (sourceType: string, dataUri: string) => void;
  /** 读快照, 自动判 TTL 过期返 null */
  getSnapshot: (sourceType: string) => ChannelSnapshot | null;
  /** 清单个 channel 快照 (例如 force refresh 时调) */
  clearSnapshot: (sourceType: string) => void;
}

export const useChannelSnapshotStore = create<ChannelSnapshotStore>((set, get) => ({
  snapshots: {},
  setSnapshot: (sourceType, dataUri) => {
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [sourceType]: { dataUri, capturedAt: Date.now() },
      },
    }));
  },
  getSnapshot: (sourceType) => {
    const snap = get().snapshots[sourceType];
    if (!snap) return null;
    if (Date.now() - snap.capturedAt > SNAPSHOT_TTL_MS) return null;
    return snap;
  },
  clearSnapshot: (sourceType) => {
    set((state) => {
      const { [sourceType]: _, ...rest } = state.snapshots;
      void _;
      return { snapshots: rest };
    });
  },
}));

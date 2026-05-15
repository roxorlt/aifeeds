// VideoColumnContext — 让视频组件不必关心自己在哪个列 / 哪个抽屉。
//
// 设计动机（设计文档 §3.4 + 2026-05-15 review 反馈）：
//   - 之前 TweetCard / PhGalleryVideo 都要传 columnId='x_list' / 'drawer'，每接入新源
//     都要复制粘贴。这违反"模板可复用"原则。
//   - 现在统一：组件树里 wrap 一层 <VideoColumnProvider>，子树里所有 video 自动归
//     该 column。同一个 TweetCard 放 feed 列和放抽屉里行为不同（columnId 不一样）。
//
// 提供：
//   - columnId：列 / context 标识（feed 列 = source_type，抽屉 = 'drawer'）
//   - scrollRoot：IntersectionObserver root；null = viewport
//   - hotZoneRatio：feed 中央"播放热区"占 scroll container 高度的比例（0..1）
//
// 用法：
//   <VideoColumnProvider columnId="x_list" scrollRoot={feedBodyRef} hotZoneRatio={0.5}>
//     <TweetCard ... />
//   </VideoColumnProvider>

import { createContext, useContext, type ReactNode, type RefObject } from "react";

export interface VideoColumnContextValue {
  columnId: string;
  /** scroll container ref；null = viewport scroll（mobile 单列 / 抽屉某些场景） */
  scrollRoot: RefObject<HTMLElement | null> | null;
  /** hot zone 占 scroll container 高度的比例 — 视频完整在该高度内才候选 */
  hotZoneRatio: number;
}

// 默认值给个 fallback，确保组件直接渲染（不在 provider 内）也不崩
const DEFAULT: VideoColumnContextValue = {
  columnId: "default",
  scrollRoot: null,
  hotZoneRatio: 0.5,
};

const VideoColumnContext = createContext<VideoColumnContextValue>(DEFAULT);

export function VideoColumnProvider({
  columnId,
  scrollRoot,
  hotZoneRatio,
  children,
}: VideoColumnContextValue & { children: ReactNode }) {
  return (
    <VideoColumnContext.Provider value={{ columnId, scrollRoot, hotZoneRatio }}>
      {children}
    </VideoColumnContext.Provider>
  );
}

export function useVideoColumn(): VideoColumnContextValue {
  return useContext(VideoColumnContext);
}

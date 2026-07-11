// VideoColumnProvider —— 把"我属于哪个列"的语义注入子树。
//
// 用法（feed / drawer 都一样）：
//   <VideoColumnProvider columnId="x_list" scrollRoot={feedBodyRef} hotZoneRatio={0.5}>
//     <TweetCard ... />
//   </VideoColumnProvider>
//
// 内部：
//   - context 暴露 columnId 给 useCoordinatedVideo 取
//   - mount 时调 store.setColumnRoot(columnId, ref.current, hotZoneRatio)
//   - unmount 时调 store.setColumnRoot(columnId, null, 0)（清 listener）
//
// 这样组件树里 video 不需要关心自己在哪——columnId 由 Provider 自动注入；
// scroll listener 由 store 中心化管理（每 root 一个，不是每 video 一个）。

import { useEffect, type ReactNode, type RefObject } from "react";
import { useVideoCoordinator } from "./videoCoordinator";
import { VideoColumnContext } from "./videoColumn";

interface ProviderProps {
  columnId: string;
  scrollRoot: RefObject<HTMLElement | null> | null;
  hotZoneRatio: number;
  children: ReactNode;
}

export function VideoColumnProvider({
  columnId,
  scrollRoot,
  hotZoneRatio,
  children,
}: ProviderProps) {
  // 注册 scroll root 到 store；ref 在 mount 完成后 .current 才有值
  useEffect(() => {
    const el = scrollRoot?.current ?? null;
    useVideoCoordinator.getState().setColumnRoot(columnId, el, hotZoneRatio);
    return () => {
      useVideoCoordinator.getState().setColumnRoot(columnId, null, 0);
    };
  }, [columnId, scrollRoot, hotZoneRatio]);

  return (
    <VideoColumnContext.Provider value={{ columnId }}>
      {children}
    </VideoColumnContext.Provider>
  );
}

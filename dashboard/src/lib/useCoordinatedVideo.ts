// useCoordinatedVideo — video element 接 VideoCoordinator 的 React hook。
//
// 视频可见性判断：hot zone 模型（设计文档 §2.1 + 2026-05-15 review 升级）。
//   feed scroll container 中央留一条"播放热区"（高度 = container.h × hotZoneRatio，
//   居中），视频完整落在该热区内 → 候选。
//   兜底：视频本身比热区高 → 视频中心穿过热区中心线即候选（覆盖未来竖版长视频）。
//
// columnId / scrollRoot / hotZoneRatio 都从最近的 <VideoColumnProvider> 取，
// 调用方只关心自己的 videoId + ref。
//
// 自动事件：mount register / unmount unregister / play / pause / 用户暂停 sticky /
//   unmute 全局 sticky / 200ms 防抖。

import { useEffect, useRef } from "react";
import { useVideoCoordinator } from "./videoCoordinator";
import { useVideoColumn } from "./videoColumnContext";

const VISIBILITY_DEBOUNCE_MS = 200;
// IntersectionObserver 的 threshold 多档（每 5% 一档），保证滚动过程中频繁触发，
// 让 hot zone 判定能跟上视频在 root 内的位置变化。
const IO_THRESHOLDS = [
  0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1,
];

export interface UseCoordinatedVideoOptions {
  videoId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export interface UseCoordinatedVideoResult {
  isActive: boolean;
  muted: boolean;
}

/**
 * hot zone 命中判断：
 *   if (video.h <= hotZone.h) → 要求 video 完整在 hotZone 内
 *   else (video 比 hotZone 还高) → 要求 video 中心点在 hotZone 内（视频盖住中心线即可）
 */
function inHotZone(targetRect: DOMRectReadOnly, rootRect: DOMRectReadOnly, ratio: number): boolean {
  const hotH = rootRect.height * ratio;
  const hotTop = rootRect.top + (rootRect.height - hotH) / 2;
  const hotBottom = hotTop + hotH;
  if (targetRect.height <= hotH) {
    return targetRect.top >= hotTop && targetRect.bottom <= hotBottom;
  }
  // 视频比热区还大 → 用视频中心点判断
  const targetCenter = targetRect.top + targetRect.height / 2;
  return targetCenter >= hotTop && targetCenter <= hotBottom;
}

export function useCoordinatedVideo({
  videoId,
  videoRef,
}: UseCoordinatedVideoOptions): UseCoordinatedVideoResult {
  const { columnId, scrollRoot, hotZoneRatio } = useVideoColumn();

  const isActive = useVideoCoordinator((s) => s.activeId === videoId);
  const globalMuted = useVideoCoordinator((s) => s.globalMuted);
  const register = useVideoCoordinator((s) => s.register);
  const unregister = useVideoCoordinator((s) => s.unregister);
  const setVisibility = useVideoCoordinator((s) => s.setVisibility);
  const markUserPaused = useVideoCoordinator((s) => s.markUserPaused);
  const setGlobalMuted = useVideoCoordinator((s) => s.setGlobalMuted);

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // mount/unmount register；columnId 变化时重新注册（drawer↔feed 切换时也走一次）
  useEffect(() => {
    register(videoId, columnId);
    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      unregister(videoId);
    };
  }, [videoId, columnId, register, unregister]);

  // IntersectionObserver — root 是 scroll container（PC 列）或 null（mobile / 默认）
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const root = scrollRoot?.current ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        const rootRect =
          e.rootBounds ??
          (root
            ? root.getBoundingClientRect()
            : ({
                top: 0,
                left: 0,
                right: window.innerWidth,
                bottom: window.innerHeight,
                width: window.innerWidth,
                height: window.innerHeight,
              } as DOMRectReadOnly));
        const meets = inHotZone(e.boundingClientRect, rootRect, hotZoneRatio);
        const top = e.boundingClientRect.top;

        if (meets) {
          if (showTimerRef.current) clearTimeout(showTimerRef.current);
          showTimerRef.current = setTimeout(() => {
            setVisibility(videoId, e.intersectionRatio, true, top);
          }, VISIBILITY_DEBOUNCE_MS);
          // 同时同步 top（不变 isVisible 标志）
          setVisibility(videoId, e.intersectionRatio, false, top);
        } else {
          if (showTimerRef.current) {
            clearTimeout(showTimerRef.current);
            showTimerRef.current = null;
          }
          setVisibility(videoId, e.intersectionRatio, false, top);
        }
      },
      { root, threshold: IO_THRESHOLDS },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [videoId, videoRef, setVisibility, scrollRoot, hotZoneRatio]);

  // active 变化 → play/pause（处理 Promise reject + 静默 fallback）
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isActive) {
      el.muted = globalMuted;
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // NotAllowedError / AbortError — 显示首帧，用户可手动 click play
        });
      }
    } else {
      if (!el.paused) el.pause();
    }
  }, [isActive, globalMuted, videoRef]);

  // mute 跟 globalMuted 同步
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = globalMuted;
  }, [globalMuted, videoRef]);

  // 用户事件追踪：pause / play / volumechange
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onPause = () => {
      const stillActive =
        useVideoCoordinator.getState().activeId === videoId;
      if (stillActive) markUserPaused(videoId, true);
    };
    const onPlay = () => markUserPaused(videoId, false);
    const onVolumeChange = () => {
      const s = useVideoCoordinator.getState();
      if (!el.muted && s.globalMuted) setGlobalMuted(false);
      else if (el.muted && !s.globalMuted) setGlobalMuted(true);
    };
    el.addEventListener("pause", onPause);
    el.addEventListener("play", onPlay);
    el.addEventListener("volumechange", onVolumeChange);
    return () => {
      el.removeEventListener("pause", onPause);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("volumechange", onVolumeChange);
    };
  }, [videoId, videoRef, markUserPaused, setGlobalMuted]);

  return { isActive, muted: globalMuted };
}

// useCoordinatedVideo — video element 接 VideoCoordinator 的 React hook。
//
// 职责（全部自动，组件只需提供 ref + 看 isActive）：
//   - mount: register；unmount: unregister
//   - IntersectionObserver 监听元素：阈值 0/0.33/0.67/1，可见 ≥ 67% + 持续 200ms
//     置 isVisible=true；< 67% 立即 false
//   - 同步 top 坐标到 store（用于优先级算法"同列取最上"）
//   - 监听 store.activeId：== 自己 → video.play()；!= → video.pause()
//   - mute 状态跟 store.globalMuted 同步
//   - 监听 video element 的 pause/play/volumechange 事件：
//     · pause 时若 store 仍认为是 active → 用户主动暂停 → markUserPaused(true)
//     · play 时 → markUserPaused(false)
//     · volumechange 时若 video unmute 但 store muted → setGlobalMuted(false) sticky
//
// 使用：
//   const ref = useRef<HTMLVideoElement>(null);
//   const { isActive, muted } = useCoordinatedVideo({
//     videoId: `x_list:${item.id}`,
//     columnId: item.source_type,
//     videoRef: ref,
//   });
//   return <video ref={ref} muted={muted} ... />

import { useEffect, useRef } from "react";
import { useVideoCoordinator } from "./videoCoordinator";

const VISIBILITY_THRESHOLD = 0.67;
const VISIBILITY_DEBOUNCE_MS = 200;

export interface UseCoordinatedVideoOptions {
  /** 全局唯一 id，建议 `${source_type}:${item.id}[:slot]` 形式 */
  videoId: string;
  /** 列 id（feed 列用 source_type，抽屉用 'drawer'） */
  columnId: string;
  /** caller 持有的 ref，hook 内部读 .current */
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export interface UseCoordinatedVideoResult {
  /** 当前是否被 coordinator 选为 active */
  isActive: boolean;
  /** 当前应显示的静音状态（受 store.globalMuted 控制） */
  muted: boolean;
}

export function useCoordinatedVideo({
  videoId,
  columnId,
  videoRef,
}: UseCoordinatedVideoOptions): UseCoordinatedVideoResult {
  const isActive = useVideoCoordinator((s) => s.activeId === videoId);
  const globalMuted = useVideoCoordinator((s) => s.globalMuted);
  const register = useVideoCoordinator((s) => s.register);
  const unregister = useVideoCoordinator((s) => s.unregister);
  const setVisibility = useVideoCoordinator((s) => s.setVisibility);
  const markUserPaused = useVideoCoordinator((s) => s.markUserPaused);
  const setGlobalMuted = useVideoCoordinator((s) => s.setGlobalMuted);

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // mount/unmount register
  useEffect(() => {
    register(videoId, columnId);
    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      unregister(videoId);
    };
  }, [videoId, columnId, register, unregister]);

  // IntersectionObserver — 阈值多档防漏触发；67% + 200ms 防抖
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        const ratio = e.intersectionRatio;
        const top = e.boundingClientRect.top;
        const meets = ratio >= VISIBILITY_THRESHOLD;

        if (meets) {
          if (showTimerRef.current) clearTimeout(showTimerRef.current);
          showTimerRef.current = setTimeout(() => {
            setVisibility(videoId, ratio, true, top);
          }, VISIBILITY_DEBOUNCE_MS);
          // 同时 sync 当前 top（不变 isVisible 标志位）
          setVisibility(videoId, ratio, false, top);
        } else {
          if (showTimerRef.current) {
            clearTimeout(showTimerRef.current);
            showTimerRef.current = null;
          }
          setVisibility(videoId, ratio, false, top);
        }
      },
      { threshold: [0, 0.33, 0.67, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [videoId, videoRef, setVisibility]);

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

  // mute 跟 globalMuted 同步（即使不 active 也同步，防下次 active 时状态错位）
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
      // 如果 store 仍认为 active=自己，那 pause 是用户主动（点 controls 上 pause）
      // 否则是 coordinator 主动调的 pause（不算 user）
      const stillActive =
        useVideoCoordinator.getState().activeId === videoId;
      if (stillActive) markUserPaused(videoId, true);
    };
    const onPlay = () => {
      // 用户在 controls 上点 play → 撤销 userPaused 标记
      markUserPaused(videoId, false);
    };
    const onVolumeChange = () => {
      // 用户 unmute → globalMuted sticky 变 false
      const s = useVideoCoordinator.getState();
      if (!el.muted && s.globalMuted) {
        setGlobalMuted(false);
      } else if (el.muted && !s.globalMuted) {
        // 用户 mute 也 sticky（让 globalMuted=true）
        setGlobalMuted(true);
      }
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

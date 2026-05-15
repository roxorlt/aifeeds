// useCoordinatedVideo —— video 组件接 VideoCoordinator 的 React hook（B 重构版）。
//
// 职责仅 3 件：
//   1. mount 时把 video element 注册到中心 store；unmount 时反注册
//   2. subscribe activeId === videoId → play / pause（Promise reject 静默 fallback）
//   3. 监听 video 的 pause / play / volumechange → 把"用户主动操作"信号回报给 store
//
// hot zone 命中、scroll 重算、跨列优先级、mode 切换全归 store，hook 不参与决策。

import { useEffect, useRef } from "react";
import { useVideoCoordinator } from "./videoCoordinator";
import { useVideoColumn } from "./videoColumnContext";

export interface UseCoordinatedVideoOptions {
  videoId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export interface UseCoordinatedVideoResult {
  isActive: boolean;
  muted: boolean;
}

const isDev = (() => {
  try { return import.meta.env?.DEV === true; } catch { return false; }
})();

function log(event: string, payload?: Record<string, unknown>): void {
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.log(`[VC.hook] ${event} ${payload ? JSON.stringify(payload) : ""}`);
}

export function useCoordinatedVideo({
  videoId,
  videoRef,
}: UseCoordinatedVideoOptions): UseCoordinatedVideoResult {
  const { columnId } = useVideoColumn();
  // 拼 columnId 前缀，避免同一 item 同时出现在 feed 和 drawer 时 videoId 撞车
  // （之前 bug：TweetCard 复用导致 feed v0 跟 drawer v7 用同一 videoId，store 互相覆盖）
  const scopedId = `${columnId}::${videoId}`;

  const isActive = useVideoCoordinator((s) => s.activeId === scopedId);
  const globalMuted = useVideoCoordinator((s) => s.globalMuted);
  const register = useVideoCoordinator((s) => s.register);
  const unregister = useVideoCoordinator((s) => s.unregister);
  const markUserPaused = useVideoCoordinator((s) => s.markUserPaused);
  const setGlobalMuted = useVideoCoordinator((s) => s.setGlobalMuted);

  // 标记 hook 内部 pause 是 coordinator 主动调（而不是 user 在 controls 上点）
  const coordPausingRef = useRef(false);

  // mount: register；unmount: unregister
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    register(scopedId, el, columnId);
    return () => unregister(scopedId);
  }, [scopedId, columnId, register, unregister, videoRef]);

  // active 变化 → play / pause
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isActive) {
      el.muted = globalMuted;
      log("play", { videoId: scopedId });
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          log("play-rejected", { videoId: scopedId });
        });
      }
    } else {
      if (!el.paused) {
        coordPausingRef.current = true;
        log("pause-by-coordinator", { videoId: scopedId });
        el.pause();
      }
    }
  }, [isActive, globalMuted, videoRef, videoId]);

  // mute 跟 globalMuted 同步
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = globalMuted;
  }, [globalMuted, videoRef]);

  // 用户事件追踪
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onPause = () => {
      if (coordPausingRef.current) {
        coordPausingRef.current = false;
        return; // coordinator 自己调的 pause，不是 user 主动
      }
      log("user-pause", { videoId: scopedId });
      markUserPaused(scopedId, true);
    };
    const onPlay = () => {
      log("user-play", { videoId: scopedId });
      markUserPaused(scopedId, false);
    };
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

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
import { getProgress, saveProgress } from "./videoProgress";

export interface UseCoordinatedVideoOptions {
  videoId: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

export interface UseCoordinatedVideoResult {
  isActive: boolean;
  muted: boolean;
}

const isDev = (() => {
  try {
    if (import.meta.env?.DEV) return true;
    if (typeof window !== "undefined") {
      const h = window.location.hostname;
      if (h === "localhost" || h === "127.0.0.1") return true;
      if (h.endsWith(".pages.dev")) return true;
      if (h.startsWith("staging.")) return true;
    }
    return false;
  } catch { return false; }
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
  // muted 状态读 session-only globalMuted（不持久化）：
  //   - 默认 true（业界做法，muted autoplay 是浏览器允许的）
  //   - user 在 video native controls 上 unmute → onVolumeChange 同步 setGlobalMuted(false)
  //   - 当前 session 内后续视频继承（user 不用每个视频重新 unmute）
  //   - 刷新重置回 true，跟浏览器 autoplay policy 一致
  const globalMuted = useVideoCoordinator((s) => s.globalMuted);
  const register = useVideoCoordinator((s) => s.register);
  const unregister = useVideoCoordinator((s) => s.unregister);
  const markUserPaused = useVideoCoordinator((s) => s.markUserPaused);
  const setGlobalMuted = useVideoCoordinator((s) => s.setGlobalMuted);

  // 标记 hook 内部 pause 是 coordinator 主动调（而不是 user 在 controls 上点）
  const coordPausingRef = useRef(false);
  // 拖动进度条期间，video 也会 fire pause/playing 事件 — 这种不算 user action，
  // 不应触发 markUserPaused（不然 drag 后 video 被 sticky 暂停）
  const seekingRef = useRef(false);
  // hook 内部主动改 el.muted（autoplay policy fallback 静音重试）— 期间触发的
  // volumechange 不应回写 prefs.muted，否则会污染 user 的"默认静音"偏好
  const hookMutingRef = useRef(false);

  // mount: register；unmount: unregister
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    register(scopedId, el, columnId);
    return () => unregister(scopedId);
  }, [scopedId, columnId, register, unregister, videoRef]);

  // active 变化 → play / pause；变 active 时同时 sync 跨 element 进度
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isActive) {
      el.muted = globalMuted;
      // 关键：从 progressMap 读最新进度（覆盖 feed/drawer 关闭前的对方播放位置）
      // pause 时另一边已 saveProgress；本 element 之前 paused 没推进 currentTime
      // 但 progress 里可能比本 currentTime 新，要同步过来。
      const saved = getProgress(videoId);
      if (saved !== undefined && Math.abs(el.currentTime - saved) > 0.3) {
        try {
          el.currentTime = saved;
          log("progress-sync-on-active", { videoId, t: saved });
        } catch {
          // seek 失败静默
        }
      }
      log("play", { videoId: scopedId, muted: el.muted });
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // 浏览器 autoplay policy 拒（user 没 interact 前不允许带声 autoplay）
          // fallback：临时 muted=true 重试 — 保证视频能播；prefs.muted 不动
          // （user 偏好仍是"不静音"，等用户 click 后再带声切换）
          log("play-rejected", { videoId: scopedId, muted: el.muted });
          if (!el.muted) {
            hookMutingRef.current = true;
            el.muted = true;
            el.play().catch(() => {
              log("play-rejected-twice", { videoId: scopedId });
            });
          }
        });
      }
    } else {
      if (!el.paused) {
        coordPausingRef.current = true;
        log("pause-by-coordinator", { videoId: scopedId });
        el.pause();
      }
    }
  }, [isActive, globalMuted, videoRef, videoId, scopedId]);

  // mute 跟 globalMuted 同步
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = globalMuted;
  }, [globalMuted, videoRef]);

  // 用户事件追踪 + 跨 element 进度同步
  // progress key 用原始 videoId（不带 columnId 前缀）→ feed 和 drawer 内的同 item
  //   video 共享 progress（一边播一边写，另一边 mount 时读）
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    // mount / src 变化时：拿到 metadata 后从 progressMap 续播
    const restoreProgress = () => {
      const saved = getProgress(videoId);
      if (saved !== undefined && Math.abs(el.currentTime - saved) > 0.3) {
        try {
          el.currentTime = saved;
          log("progress-restore", { videoId, t: saved });
        } catch {
          // 某些视频 source 不支持 seek，静默
        }
      }
    };
    if (el.readyState >= 1) restoreProgress();
    el.addEventListener("loadedmetadata", restoreProgress);

    // timeupdate 节流写：每 800ms 最多一次
    let lastSave = 0;
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastSave < 800) return;
      lastSave = now;
      saveProgress(videoId, el.currentTime);
    };

    const onPause = () => {
      // 立即写进度（关抽屉、切换 active 前的最后机会）
      saveProgress(videoId, el.currentTime);
      if (coordPausingRef.current) {
        coordPausingRef.current = false;
        return;
      }
      if (seekingRef.current) {
        // 拖动进度条期间 video 自动 pause，不算 user 主动暂停
        return;
      }
      log("user-pause", { videoId: scopedId });
      markUserPaused(scopedId, true);
    };
    const onPlay = () => {
      if (seekingRef.current) {
        // seek 完成后 video 自动 resume 也不算 user 主动 play
        return;
      }
      log("user-play", { videoId: scopedId });
      markUserPaused(scopedId, false);
    };
    const onSeeking = () => { seekingRef.current = true; };
    const onSeeked = () => { seekingRef.current = false; };
    const onVolumeChange = () => {
      // 跳过 hook 内部 muted=true fallback 触发的 volumechange（不算 user action）
      if (hookMutingRef.current) {
        hookMutingRef.current = false;
        return;
      }
      const s = useVideoCoordinator.getState();
      if (!el.muted && s.globalMuted) setGlobalMuted(false);
      else if (el.muted && !s.globalMuted) setGlobalMuted(true);
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("pause", onPause);
    el.addEventListener("play", onPlay);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("volumechange", onVolumeChange);
    return () => {
      // unmount 也存一次（保证关抽屉时 feed video 拿到最新）
      saveProgress(videoId, el.currentTime);
      el.removeEventListener("loadedmetadata", restoreProgress);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("volumechange", onVolumeChange);
    };
  }, [videoId, scopedId, videoRef, markUserPaused, setGlobalMuted]);

  return { isActive, muted: globalMuted };
}

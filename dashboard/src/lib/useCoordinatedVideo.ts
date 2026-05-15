// useCoordinatedVideo —— video 组件接 VideoCoordinator 的 React hook。
//
// 职责：
//   1. mount 注册 / unmount 反注册到中心 store
//   2. 订阅 activeId === scopedId → 自动 play / pause（autoplay policy fallback：静音重试）
//   3. mute 跟 globalMuted 双向同步（video controls unmute → store；store 变化 → el.muted）
//   4. 跨 element 进度续播（videoProgress map）：feed → drawer / drawer → feed
//
// 不做：
//   - 不再 markUserPaused (sticky 暂停) — 浏览器在 mute 切换 / autoplay policy 等场景下
//     fire 的 pause event 很难跟"真 user pause"区分。错把它当成 user-pause 会导致
//     mute / unmute 后视频卡住。Twitter / Instagram 都不做 sticky，本项目同步去掉。
//   - hot zone 命中、scroll 重算、跨列优先级、mode 切换全归 store，hook 不参与决策

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

  // active 变化 → play / pause
  // 进度同步只在 mount loadedmetadata 时做一次（feed → drawer 单向续播）。
  // 不在这里 set currentTime — 否则 user 拖完进度条后，store 里某个状态变化
  // 触发 useEffect re-run 时会强制把 ct 覆盖回 progress map 里的旧值，
  // user seek 等于白做（review 反馈：切换进度后又被识别成 pause）。
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isActive) {
      el.muted = globalMuted;
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
      // 关抽屉 / 切换 active 前的最后机会保存进度
      saveProgress(videoId, el.currentTime);
      // 注：不再调 markUserPaused(true)，原因：
      //   user 点 mute / unmute / 拖进度条 / 浏览器 autoplay policy 等
      //   场景下 video 都会 fire pause event，难以可靠区分"真用户暂停"vs
      //   "浏览器/浏览器引擎自动 pause"。误判会把视频 sticky 暂停。
      //   Twitter / Instagram 都不做 user-pause sticky，本项目同样去掉。
      //   视觉体验：user 点 pause 后视频确实暂停（video element 原生行为），
      //   滚走再滚回视口时 coord 重选 active 自动恢复 play。
    };
    // onPlay handler 删除：sticky 撤销逻辑跟 sticky 标记是一组，没了 sticky
    //   就不需要撤销。video 自身的 play / replay 由 coord 调度处理。
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
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("volumechange", onVolumeChange);
    return () => {
      // unmount 也存一次（保证关抽屉时 feed video 拿到最新）
      saveProgress(videoId, el.currentTime);
      el.removeEventListener("loadedmetadata", restoreProgress);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("volumechange", onVolumeChange);
    };
  }, [videoId, videoRef, setGlobalMuted]);

  return { isActive, muted: globalMuted };
}

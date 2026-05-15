// 把 user.preferences.video 跟 VideoCoordinator 的 prefs 双向 sync。
//
// 单向流程：
//   登录 / 拉新 user → user.preferences.video 存在 → 用云端覆盖 coordinator prefs
//   coordinator.setPrefs() → debounce 800ms → PUT /api/auth/me/preferences（仅登录态）
//
// 设计：
//   - 不直接让 authStore / coordinator 互相 import（避免 zustand store 循环依赖）
//   - 所有桥接逻辑放本文件，由 App.tsx 顶层 attach 一次
//   - 未登录用户：localStorage 已生效，本模块 noop
//   - 登录冲突解决：永远以服务端为权威（用户在 A 设备改了，B 设备登录看到 A 的值）

import { API_BASE } from "../api";
import { useAuthStore } from "./authStore";
import { useVideoCoordinator, type VideoPrefs } from "./videoCoordinator";

interface UserPrefsShape {
  video?: Partial<VideoPrefs>;
  // 未来其它 prefs 加这里（subscriptions / theme / etc.）
}

let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let lastUploadedJson: string | null = null;

/** debounce 上传当前 prefs 到云端（仅登录态） */
function uploadPrefsDebounced() {
  const user = useAuthStore.getState().user;
  if (!user) return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    const prefs = useVideoCoordinator.getState().prefs;
    const body = { video: prefs };
    const json = JSON.stringify(body);
    if (json === lastUploadedJson) return; // dedup 同值上传
    lastUploadedJson = json;
    fetch(`${API_BASE}/api/auth/me/preferences`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: json,
    }).catch(() => {
      // 静默失败 — localStorage 已生效，下次改设置或刷新会重试
    });
  }, 800);
}

/** App.tsx 顶层 mount 调一次，返回 cleanup */
export function attachVideoPrefsSync(): () => void {
  // (1) 用户变化 → 用云端覆盖本地
  let lastUserId: string | null = useAuthStore.getState().user?.id ?? null;
  const unsubAuth = useAuthStore.subscribe((state) => {
    const userId = state.user?.id ?? null;
    // 只在用户身份切换 / 首次登录时同步（避免 user 同 id 但其它字段变化也触发）
    if (userId === lastUserId) return;
    lastUserId = userId;
    if (!state.user) return;
    const cloud = (state.user.preferences as UserPrefsShape | null | undefined)?.video;
    if (!cloud) {
      // 云端无 prefs（首次登录该账号）→ 立即把当前 localStorage 值同步上去
      lastUploadedJson = null; // 强制下次上传
      uploadPrefsDebounced();
      return;
    }
    // 用云端覆盖本地（注意：setPrefs 会触发后续 subscribe 上传，但 dedup 拦住）
    const merged = { ...useVideoCoordinator.getState().prefs, ...cloud };
    lastUploadedJson = JSON.stringify({ video: merged }); // 标记跟云端一致避免回灌
    useVideoCoordinator.getState().setPrefs(merged);
  });

  // (2) prefs 改 → debounce 上传
  let lastPrefs = useVideoCoordinator.getState().prefs;
  const unsubVC = useVideoCoordinator.subscribe((state) => {
    if (state.prefs === lastPrefs) return;
    lastPrefs = state.prefs;
    uploadPrefsDebounced();
  });

  return () => {
    unsubAuth();
    unsubVC();
  };
}

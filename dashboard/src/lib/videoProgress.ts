// videoProgress —— 跨 video element 共享的播放进度。
//
// 场景：同一 item 的视频在 feed 列和抽屉里是两个独立的 <video> element（DOM
// 不同 instance），各自维护 currentTime。用户在 feed A 播到 0:30 → 打开抽屉，
// 抽屉里的 A 也应该从 0:30 续播；关抽屉时反向同步。
//
// 实现：module-level Map<itemId, currentTime>，session 内有效（刷新页面归零）。
// hook 在 mount/loadedmetadata 时读 + 设 video.currentTime；timeupdate 节流（每
// 800ms）写；pause 立即写（确保关抽屉前进度最新）。
//
// itemId ≠ scopedId：itemId 是 caller 传的 videoId（如 `x_list:2054...`），feed
// 和 drawer 内 hook 用同一 itemId 共享进度。scopedId（columnId 前缀）只用于
// store 内部唯一标识（避免 active 选错）。
//
// 不持久化：跨 session 续播是不同需求（YouTube/B 站的"上次看到 X 秒"），
// v1 先 cover session 内同源切换。如需跨刷新，加 sessionStorage / localStorage。

const progress = new Map<string, number>();

/** 关键阈值：currentTime < 这个值不写，避免 mount 刚 attach 就 0s 覆盖旧记录 */
const MIN_WRITE_SEC = 0.5;

/** 读：返回上次记录的 currentTime；未记录返回 undefined */
export function getProgress(itemId: string): number | undefined {
  return progress.get(itemId);
}

/** 写：节流由 caller 控制；pause 时强制立即写 */
export function saveProgress(itemId: string, currentTime: number): void {
  if (!Number.isFinite(currentTime) || currentTime < MIN_WRITE_SEC) return;
  progress.set(itemId, currentTime);
}

/** 清掉某 item 的进度（如视频播完）— 可选，不调也无害（下次 save 覆盖） */
export function clearProgress(itemId: string): void {
  progress.delete(itemId);
}

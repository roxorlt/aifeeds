// pagehide / visibilitychange 时把队列 flush 出去
// iOS Safari 不会触发 unload，但会触发 pagehide

import { flushSync } from './queue';

export function installBeacon(): void {
  if (typeof window === 'undefined') return;

  // pagehide：关闭 tab、刷新、navigate 离开
  window.addEventListener('pagehide', () => {
    flushSync(true);
  });

  // visibilitychange → hidden：切到后台（移动端尤其常见）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSync(true);
    }
  });
}

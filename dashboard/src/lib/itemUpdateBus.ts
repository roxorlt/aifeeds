// 跨组件同步 item 更新的小总线。
// 用途：drawer 触发 lazy-enrich 拿到新数据后，要把同 id 的卡片在 feed 流里也
// 替换掉，避免出现「抽屉内数据新、feed 卡片仍是老数据」。
//
// 维持轻量：Feed 的列表 state 仍保留组件本地（pagination / sort / scroll 都
// 锁在那里），只用这条总线把 drawer→feed 的「单条更新」打通。完整迁移到
// zustand store 留到 PR7。

import type { Item } from "../types";

type Listener = (item: Item) => void;
const listeners = new Set<Listener>();

export function subscribeItemUpdate(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function dispatchItemUpdate(item: Item): void {
  for (const fn of listeners) {
    try {
      fn(item);
    } catch {
      // 单个订阅者出错不影响其他订阅者
    }
  }
}

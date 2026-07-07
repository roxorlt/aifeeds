import type { MouseEvent } from "react";
import type { Item } from "../../types";
import { track, EVENTS } from "../../lib/telemetry";

// 召回上限（worker RECALL_LIMIT）。组头 total 命中上限时展示「200+」。
export const RECALL_CAP = 200;

// 空态热搜 chip / 结果页 chip 统一样式（对齐 SearchStart 的 chipBase，neutral 无彩色）。
export const chipBase =
  "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-200";

// 结果卡点击埋点。ItemCard 各源卡片自身 onClick 已调 drawer.openItem 打开抽屉
// （不 stopPropagation），点击冒泡到外层 wrapper 触发本函数补埋 SEARCH_RESULT_CLICK。
// 与卡片打开抽屉的判定对齐：命中内部 button / a（译文按钮、外链、图片灯箱等，均
// 不开抽屉）或正在选中文本时不计一次结果点击，避免虚高。
// groupIndex：分组页传组序，单源流传 null。
export function trackResultClick(
  e: MouseEvent,
  item: Item,
  position: number,
  groupIndex: number | null,
): void {
  const target = e.target as HTMLElement;
  if (target.closest("button") || target.closest("a")) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return;
  track(EVENTS.SEARCH_RESULT_CLICK, {
    item_id: item.id,
    source_type: item.source_type,
    position,
    group_index: groupIndex,
  });
}

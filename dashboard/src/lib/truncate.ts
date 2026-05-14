/**
 * 智能字符串截断 — 优先在"自然停顿处"切，避免难看的 ellipsis 位置。
 *
 * 优先级（从最优到兜底）：
 *   1. 句末符号（。！？.!?\n）— 整句保留
 *   2. 中等停顿（，；,;:）          — 短句保留
 *   3. 词 / 字符边界（空格 / 中英文分界）— 不切英文词中间
 *   4. 未闭合 markdown 链接 `[xxx](` — 在 `[` 之前切，避免 `[文](htt…`
 *   5. 兜底硬截
 *
 * 输入文本 ≤ maxLen 时直接返回原文，不加 ellipsis。
 *
 * 用于 feed 卡片正文（TweetCard / GithubCard / PhCard / ClawhubCard /
 * HuodongxingCard），跟 CSS line-clamp 配合：JS 先截到字数上限，
 * line-clamp 兜底保证视觉行数不超。
 */
export function smartTruncate(
  text: string,
  maxLen = 280,
  ellipsis = "…",
): string {
  if (!text) return "";
  // Array.from 处理 unicode 正确（emoji / surrogate pair 不会被切半）
  const chars = Array.from(text);
  if (chars.length <= maxLen) return text;

  const window = chars.slice(0, maxLen).join("");
  // 在末尾 lookback 字符内找切点；超出 lookback 就放弃此优先级
  const lookback = Math.min(60, Math.floor(maxLen * 0.3));
  const minCut = window.length - lookback;

  const findLast = (re: RegExp, includeMatch: boolean): number => {
    let last = -1;
    let m;
    while ((m = re.exec(window)) !== null) {
      const end = m.index + (includeMatch ? m[0].length : 0);
      if (end >= minCut && end <= window.length) last = end;
    }
    return last;
  };

  // 1. 句末符号
  const sentEnd = findLast(/[。！？.!?\n]/g, true);
  if (sentEnd > 0) return window.slice(0, sentEnd) + ellipsis;

  // 2. 中等停顿
  const pause = findLast(/[，；,;:：]/g, true);
  if (pause > 0) return window.slice(0, pause) + ellipsis;

  // 3a. 空格词边界
  const space = findLast(/[\s ]/g, false);
  if (space > 0) return window.slice(0, space) + ellipsis;

  // 3b. 中英文分界（中-英 或 英-中 之间是天然词边界）
  const langBoundary = findLast(/[一-龥][a-zA-Z]|[a-zA-Z][一-龥]/g, false);
  if (langBoundary > 0) return window.slice(0, langBoundary + 1) + ellipsis;

  // 4. 未闭合 markdown 链接保护：[xxx](htt 这种切到 `[` 之前去
  const lastOpen = window.lastIndexOf("[");
  const lastClose = window.lastIndexOf(")");
  if (lastOpen > lastClose && lastOpen > minCut - 10) {
    return window.slice(0, lastOpen).trimEnd() + ellipsis;
  }

  // 5. 兜底硬截
  return window + ellipsis;
}

// PM 2026-05-22 反馈:抽屉里出现指向 X 推文的 link card 没意义 — 要么 self-preview
// (用户已经在看这条推, 底部"打开 X 原文"按钮就是这个功能), 要么 quote 重复
// (quote_of 嵌套小卡已经显示同推文). 扩展过滤为所有 x.com/twitter.com/<handle>/
// status/<id> URL, 不只本推文自身.

export function isSelfLinkCard(
  card: { url?: string | null } | null | undefined,
  handle?: string | null,
  sourceId?: string | null,
): boolean {
  if (!card?.url) return false;
  try {
    const u = new URL(card.url);
    if (u.hostname !== "x.com" && u.hostname !== "twitter.com" && u.hostname !== "www.x.com") {
      return false;
    }
    // 任何 X 推文 URL 都过滤(包括本推文 self-preview + 别人推文的 link preview)
    void handle; void sourceId;
    return /^\/[^/]+\/status\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

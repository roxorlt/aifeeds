// PM 2026-05-22 反馈:抽屉里出现指向本推文自己的 link card (twitter.com/handle/status/<id>),
// 是 X syndication API 对 status URL 的 self-preview。这种 card 没意义 (用户已经在
// 看这条推, 底部"打开 X 原文"按钮就是这个功能)。
//
// 共享 util:FE TweetCard / 海报 svg-template 都用此判断过滤。

import type { LinkCard } from "../types";

export function isSelfLinkCard(
  card: { url?: string | null } | null | undefined,
  handle: string | null | undefined,
  sourceId: string | null | undefined,
): boolean {
  if (!card?.url) return false;
  try {
    const u = new URL(card.url);
    if (u.hostname !== "x.com" && u.hostname !== "twitter.com" && u.hostname !== "www.x.com") {
      return false;
    }
    // Path: /<handle>/status/<id> 或 /<handle>/status/<id>?...
    // 任一 handle 跟主推 handle 同 + id 跟 source_id 同 → 指向自己
    if (!sourceId) return false;
    const m = u.pathname.match(/^\/[^/]+\/status\/(\d+)/);
    if (!m) return false;
    if (m[1] !== sourceId) return false;
    // handle 可对不上(分享时 URL 含原作者 handle, 跟主推 handle 一致才算 self)
    // 但简化为 status_id 一致就算 self,即便 handle 不同(罕见但理论上仍是自引用)
    void handle;
    return true;
  } catch {
    return false;
  }
}

// 海报端用,接 worker 的 LinkCard 字段
export function isSelfLinkCardForExtra(
  linkCard: Pick<LinkCard, "url"> | null | undefined,
  handle: string | null | undefined,
  sourceId: string | null | undefined,
): boolean {
  return isSelfLinkCard(linkCard, handle, sourceId);
}

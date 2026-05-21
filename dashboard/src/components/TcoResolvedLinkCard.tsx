// PR4 (2026-05-21): 当 content 是纯单条 t.co 短链 + BE 已 resolve 出真实 URL 时,
// 把光秃秃的 https://t.co/XXX 文本替换成可识别 link card (几乎全是 X Articles)。
// 失败态 (content_resolve_failed_at 有) / 没 resolved_url → 不渲染本组件,
// 由 caller fallback 渲染原文本。
//
// BE PR #99 字段在 6 个 path:
//   L1 extra.content_resolved_url / content_resolve_failed_at
//   L2 extra.{quote_of, reply_of, retweet_of}.content_resolved_url
//   L3 extra.{quote_of, reply_of, retweet_of}.quote_of.content_resolved_url
//
// 用法 (caller 决定是否 fallback):
//   const card = renderTcoLinkCardIfApplicable(content, resolvedUrl);
//   return card ?? <span>{content}</span>;

const TCO_ONLY_RE = /^\s*https?:\/\/t\.co\/\S+\s*$/i;

export function isTcoOnly(content: string | null | undefined): boolean {
  return typeof content === "string" && TCO_ONLY_RE.test(content);
}

// 从 resolved URL 推断显示文案。X Article URL 形如:
// https://x.com/i/article/2055126803224883200 → "X 文章"
// 其他域(罕见, 比如 youtube / github 直链) → 显示 domain
function inferLabel(resolvedUrl: string): { label: string; icon: string } {
  try {
    const u = new URL(resolvedUrl);
    if (u.hostname.endsWith("x.com") || u.hostname.endsWith("twitter.com")) {
      if (u.pathname.startsWith("/i/article/")) {
        return { label: "X 文章", icon: "📄" };
      }
      // 跳到其他 X 链接 (status / profile),罕见
      return { label: "X 链接", icon: "🔗" };
    }
    // 跳出 X 的链接(罕见但有可能,比如 YouTube / GitHub 直链)
    return { label: u.hostname.replace(/^www\./, ""), icon: "🔗" };
  } catch {
    return { label: "外链", icon: "🔗" };
  }
}

interface Props {
  content: string | null | undefined;
  resolvedUrl: string | null | undefined;
  // 在嵌套 quote 小卡 / modal 内使用 compact 样式(更小 padding, 单行)
  compact?: boolean;
}

export function TcoResolvedLinkCard({ content, resolvedUrl, compact }: Props) {
  if (!isTcoOnly(content) || !resolvedUrl) return null;
  const { label, icon } = inferLabel(resolvedUrl);
  // 用 try-catch 已 cover,这里安全;href 直接用 resolvedUrl(BE 保证最终 URL)
  return (
    <a
      href={resolvedUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={
        compact
          ? "mt-1 inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-neutral-200 bg-neutral-50/60 px-2 py-1 text-[12px] text-neutral-700 hover:bg-neutral-100"
          : "mt-2 inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-neutral-200 bg-neutral-50/60 px-2.5 py-1.5 text-[13px] text-neutral-700 hover:bg-neutral-100"
      }
    >
      <span className="shrink-0">{icon}</span>
      <span className="shrink-0 font-medium">{label}</span>
      <span className="truncate text-neutral-500">{resolvedUrl}</span>
      <span className="shrink-0 text-neutral-400">↗</span>
    </a>
  );
}

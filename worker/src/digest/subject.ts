export function digestSubjectTitleFromRow(row: {
  title: string | null;
  content_translated: string | null;
  content: string | null;
  extra: string | null;
} | undefined): string {
  if (!row) return '';
  let ex: Record<string, unknown> = {};
  try {
    ex = JSON.parse(row.extra || '{}') as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return String(
    (ex.title_zh as string)
      || row.title
      || (row.content_translated || row.content || '').slice(0, 40),
  ).trim();
}

export function buildDigestSubjectFallback(titles: string[], maxLen = 90): string {
  const phrases = titles
    .map((title) => String(title || '').replace(/\s+/g, ' ').replace(/[。.]$/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!phrases.length) return '今日 AI 精选';
  const joined = phrases.join('、');
  if (joined.length <= maxLen) return joined;
  return `${joined.slice(0, Math.max(0, maxLen - 1)).replace(/[，,、；;：:\s]+$/g, '')}…`;
}

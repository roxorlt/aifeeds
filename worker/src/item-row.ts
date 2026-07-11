// worker/src/item-row.ts
// items 行 → API Item 的共享映射器。原先内联在 index.ts（handleItems 等多处调用），
// 2026-07-06 抽出为无 worker 依赖的独立模块，供 /api/search 与详情复用，
// 并让纯逻辑可在 node 下单测。2026-07-11 起 feed `/api/items` 使用独立的
// list-item DTO；搜索保留自己的既有响应契约，不随 list DTO 自动收窄。

// Legacy search responses and detail-thread siblings still use this mapper.
// `/api/items` feed lists now use the positive DTO allowlists in list-item.ts;
// item detail keeps calling parseItemRow(row, true) and therefore remains full.
// The default blacklist below preserves the existing search response contract.
export const LIST_HEAVY_EXTRA_KEYS = [
  'top_comments', 'llm_analysis', 'files_manifest', 'discussion_comments',
  // blog/podcast 全文类重字段(blog 正文 markdown 几十 KB、podcast 文字稿更大):
  // 搜索预览只用摘要；全文仍由 fetchItem(full=true) 返回。
  'body_markdown', 'body_markdown_zh', 'transcript_text', 'transcript_text_zh', 'shownotes', 'shownotes_zh',
];

export function parseItemRow(row: Record<string, unknown>, full = false): Record<string, unknown> {
  const parsed = { ...row };
  for (const field of ['media', 'metrics', 'extra']) {
    if (typeof parsed[field] === 'string') {
      try { parsed[field] = JSON.parse(parsed[field] as string); } catch {}
    }
  }
  if (!full && parsed.extra && typeof parsed.extra === 'object') {
    const ex = parsed.extra as Record<string, unknown>;
    for (const k of LIST_HEAVY_EXTRA_KEYS) {
      if (k in ex) delete ex[k];
    }
  }
  // clawhub: content/content_translated 装的是 README 全文(单条 ~5KB),但卡片正文用
  // extra.summary_translated(200 字);全文只在抽屉渲染(ClawhubDrawerBody 走 fetchItem
  // 拿完整 item)。legacy 非 full 响应截断到预览长度。X 不截(展开要全文)。
  if (!full && parsed.source_type === 'clawhub') {
    if (typeof parsed.content === 'string' && parsed.content.length > 280) {
      parsed.content = parsed.content.slice(0, 280);
    }
    if (typeof parsed.content_translated === 'string' && parsed.content_translated.length > 280) {
      parsed.content_translated = parsed.content_translated.slice(0, 280);
    }
  }
  // blog/podcast 同款(2026-06-11):content 装 excerpt/shownotes 纯文本(podcast 均
  // ~1KB、max 2.7KB),卡片摘要走 extra.ai_summary_zh、content 只作 fallback 且
  // clamp 2-3 行(280 足够);全文在抽屉(DrawerBody 自拉 fetchItem full)。
  if (!full && (parsed.source_type === 'blog' || parsed.source_type === 'podcast')) {
    if (typeof parsed.content === 'string' && parsed.content.length > 280) {
      parsed.content = parsed.content.slice(0, 280);
    }
    if (typeof parsed.content_translated === 'string' && parsed.content_translated.length > 280) {
      parsed.content_translated = parsed.content_translated.slice(0, 280);
    }
  }
  return parsed;
}

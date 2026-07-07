// worker/src/item-row.ts
// items 行 → API Item 的共享映射器。原先内联在 index.ts（handleItems 等多处调用），
// 2026-07-06 抽出为无 worker 依赖的独立模块，供 /api/search 复用同款映射
// （搜索响应 Item 必须与 /api/items 完全一致），并让纯逻辑可在 node 下单测。
// ⚠️ 抽取时行为逐字不变；改动务必同时校对 handleItems 的输出。

// 抽屉才用的重字段:feed 列表不渲染,但单条能占 item 90% 体积(PH top_comments 一条
// 12-18KB)。列表默认剥掉,抽屉打开走 fetchItem(GET /api/items/:id, full=true)拿完整 extra。
export const LIST_HEAVY_EXTRA_KEYS = [
  'top_comments', 'llm_analysis', 'files_manifest', 'discussion_comments',
  // blog/podcast 全文类重字段(blog 正文 markdown 几十 KB、podcast 文字稿更大):
  // 卡片只用 ai_summary/标题摘要,全文只在抽屉渲染(fetchItem full=true 拿完整 extra)。
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
  // 拿完整 item)。列表里截断到预览长度,省掉 feed 最大的一块体积。X 不截(展开要全文)。
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

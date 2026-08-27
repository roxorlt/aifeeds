// Z.ai 官方模型仓库发现：z.ai blog 没有可枚举索引，官方 sitemap 也不含 blog。
// Hugging Face 的 zai-org 组织模型列表是最小的一手发现通道；repo id 作为 guid，
// 因而普通 lastModified 更新会命中既有 item，不会制造新的新闻事件。

import type { FeedDef, ParsedFeedItem } from './types';
import { throttledFetchText } from './extract';

interface HuggingFaceModelListRow {
  id?: unknown;
  author?: unknown;
  createdAt?: unknown;
  lastModified?: unknown;
}

export async function discoverZaiOrgModels(feed: FeedDef): Promise<ParsedFeedItem[]> {
  const body = await throttledFetchText(feed.feed_url);
  return parseZaiOrgModelList(body || '');
}

export function parseZaiOrgModelList(body: string): ParsedFeedItem[] {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const items: ParsedFeedItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const model = row as HuggingFaceModelListRow;
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    const author = typeof model.author === 'string' ? model.author.trim() : '';
    if (!id.startsWith('zai-org/') || (author && author !== 'zai-org') || seen.has(id)) continue;
    seen.add(id);

    const repo = id.slice('zai-org/'.length);
    const createdAt = typeof model.createdAt === 'string' ? model.createdAt : undefined;
    const lastModified = typeof model.lastModified === 'string' ? model.lastModified : undefined;
    items.push({
      guid: id,
      link: `https://huggingface.co/${id}`,
      title: `Z.ai model release: ${repo}`,
      published_at: createdAt || lastModified,
    });
  }
  return items;
}

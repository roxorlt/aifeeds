// Z.ai 官方模型仓库发现：z.ai blog 没有可枚举索引，官方 sitemap 也不含 blog。
// Hugging Face 的 zai-org 组织模型列表是最小的一手发现通道；API _id 作为不可变 guid，
// 因而仓库改名/普通 lastModified 更新会命中既有 item，不会制造新的新闻事件。

import type { FeedDef, ParsedFeedItem } from './types';
import { throttledFetchTextPage, type ThrottledTextPage } from './extract';

interface HuggingFaceModelListRow {
  _id?: unknown;
  id?: unknown;
  modelId?: unknown;
  author?: unknown;
  private?: unknown;
  createdAt?: unknown;
  lastModified?: unknown;
}

const ZAI_MODEL_PAGE_LIMIT = 5;
const ZAI_MODEL_RELEASE_MAX_AGE_MS = 30 * 86400_000;

type ZaiModelPageFetcher = (url: string) => Promise<ThrottledTextPage | null>;

export interface ZaiModelDiscoveryOptions {
  now?: Date;
  fetchPage?: ZaiModelPageFetcher;
}

export async function discoverZaiOrgModels(
  feed: FeedDef,
  options: ZaiModelDiscoveryOptions = {},
): Promise<ParsedFeedItem[]> {
  const fetchPage = options.fetchPage || throttledFetchTextPage;
  const now = options.now || new Date();
  const initial = new URL(feed.feed_url);
  let nextUrl: string | null = initial.toString();
  const fetchedUrls = new Set<string>();
  const seenGuids = new Set<string>();
  const items: ParsedFeedItem[] = [];

  for (let page = 0; page < ZAI_MODEL_PAGE_LIMIT && nextUrl; page++) {
    if (fetchedUrls.has(nextUrl)) break;
    fetchedUrls.add(nextUrl);
    const fetched = await fetchPage(nextUrl);
    if (!fetched) break;
    const pageItems = parseZaiOrgModelList(fetched.body, now);
    for (const item of pageItems) {
      if (seenGuids.has(item.guid)) continue;
      seenGuids.add(item.guid);
      items.push(item);
    }
    if (!fetched.nextUrl) break;
    let candidate: URL;
    try {
      candidate = new URL(fetched.nextUrl, nextUrl);
    } catch {
      break;
    }
    // Link is server-controlled metadata. Follow only the same official API collection and
    // retain the organization filter; never turn it into an open redirect fetch primitive.
    if (
      candidate.origin !== initial.origin
      || candidate.pathname !== initial.pathname
      || candidate.searchParams.get('author') !== 'zai-org'
    ) break;
    nextUrl = candidate.toString();
  }

  return items;
}

export function parseZaiOrgModelList(body: string, now = new Date()): ParsedFeedItem[] {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const items: ParsedFeedItem[] = [];
  const nowMs = now.getTime();
  const oldestReleaseMs = nowMs - ZAI_MODEL_RELEASE_MAX_AGE_MS;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const model = row as HuggingFaceModelListRow;
    const immutableId = typeof model._id === 'string' ? model._id.trim() : '';
    const id = typeof model.modelId === 'string'
      ? model.modelId.trim()
      : typeof model.id === 'string' ? model.id.trim() : '';
    const author = typeof model.author === 'string' ? model.author.trim() : '';
    const createdAt = typeof model.createdAt === 'string' ? model.createdAt.trim() : '';
    const createdAtMs = Date.parse(createdAt);
    if (
      !immutableId
      || !id.startsWith('zai-org/')
      || (author && author !== 'zai-org')
      || model.private === true
      || !Number.isFinite(createdAtMs)
      || createdAtMs < oldestReleaseMs
      || createdAtMs > nowMs + 24 * 3600_000
      || seen.has(immutableId)
    ) continue;
    seen.add(immutableId);

    const repo = id.slice('zai-org/'.length);
    items.push({
      guid: `hf-model:${immutableId}`,
      link: `https://huggingface.co/${id}`,
      title: `Z.ai model release: ${repo}`,
      // lastModified is intentionally never a release timestamp: an old repo update or a
      // private→public visibility change must not become a current news event.
      published_at: createdAt,
    });
  }
  return items;
}

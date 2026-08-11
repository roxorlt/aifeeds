import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import { fetchPublicDocument, type PublicDocument } from '../security/safe-url-fetch';
import type { ManualNewsEvidence, ManualEvidenceSourceType } from './manual-news-leads';
import {
  processManualNewsLead,
  type ManualLeadProcessingAdapters,
  type ManualSearchResult,
} from './manual-news-leads-pipeline';
import { D1ManualLeadProcessingStore } from './manual-news-leads-store';

interface SearchRow {
  title: string | null;
  content: string | null;
  content_translated: string | null;
  url: string | null;
  published_at: string | null;
  extra: string | null;
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function compact(value: unknown, max: number): string {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}|[\u3400-\u9fff]{2,}/g) || []) {
    if (/^[\u3400-\u9fff]+$/.test(token) && token.length > 6) {
      for (let index = 0; index < token.length - 1 && terms.size < 8; index += 2) terms.add(token.slice(index, index + 4));
    } else {
      terms.add(token);
    }
    if (terms.size >= 8) break;
  }
  return [...terms];
}

function sourceIdentity(urlValue: string): { source_type: ManualEvidenceSourceType; reliable: boolean; publisher: string } {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return { source_type: 'other', reliable: false, publisher: '' };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host.endsWith('.gov') || host.endsWith('.senate.gov') || host.endsWith('.house.gov')) {
    return { source_type: 'original_document', reliable: true, publisher: host };
  }
  if (/^(support|help|docs)\./.test(host) && /(claude|anthropic|openai|google|microsoft|meta|nvidia)/.test(host)) {
    return { source_type: 'official_help', reliable: true, publisher: host };
  }
  const officialHosts = [
    'anthropic.com', 'claude.com', 'openai.com', 'deepmind.google', 'blog.google', 'ai.meta.com',
    'meta.com', 'nvidia.com', 'microsoft.com', 'github.blog', 'huggingface.co',
  ];
  if (officialHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { source_type: 'official_primary', reliable: true, publisher: host };
  }
  const independentHosts = [
    'axios.com', 'reuters.com', 'apnews.com', 'theverge.com', 'techcrunch.com', 'bloomberg.com',
    'wsj.com', 'nytimes.com', 'ft.com', 'jiqizhixin.com', 'qbitai.com', '36kr.com',
  ];
  if (independentHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { source_type: 'independent_media', reliable: true, publisher: host };
  }
  return { source_type: 'other', reliable: false, publisher: host };
}

function decodeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedPublishedAt(body: string, hinted: string | null | undefined): string | null {
  const candidates = [hinted || ''];
  for (const tag of body.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)) {
      attributes.set(match[1].toLowerCase(), match[2]);
    }
    const key = (attributes.get('property') || attributes.get('name') || attributes.get('itemprop') || '').toLowerCase();
    if (['article:published_time', 'datepublished', 'date', 'pubdate'].includes(key)) {
      candidates.push(attributes.get('content') || '');
    }
  }
  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(body);
  if (time) candidates.push(time[1]);
  for (const value of candidates) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) continue;
    const timestamp = Date.parse(value);
    if (value && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

async function evidenceId(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `ev-${hash.slice(0, 12)}`;
}

export async function extractManualNewsEvidence(
  document: PublicDocument,
  hint?: ManualSearchResult,
  now = Date.now(),
): Promise<ManualNewsEvidence | null> {
  const identity = sourceIdentity(document.url);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(document.body);
  const title = compact(hint?.title || (titleMatch ? decodeHtml(titleMatch[1]) : ''), 220);
  const excerpt = compact(hint?.snippet || decodeHtml(document.body), 3_000);
  if (!title && !excerpt) return null;
  return {
    id: await evidenceId(document.url),
    url: document.url,
    source_type: hint?.source_type || identity.source_type,
    publisher: compact(hint?.publisher || identity.publisher, 120),
    published_at: normalizedPublishedAt(document.body, hint?.published_at),
    retrieved_at: now,
    title,
    excerpt,
    claims_supported: excerpt ? [excerpt] : [],
    reliable: hint?.reliable ?? identity.reliable,
  };
}

async function searchExistingNews(env: Env, input: { text: string }): Promise<ManualSearchResult[]> {
  const terms = searchTerms(input.text);
  if (!terms.length) return [];
  const predicates = terms.map(() => `(lower(COALESCE(title, '')) LIKE ? OR lower(COALESCE(content_translated, content, '')) LIKE ?)`).join(' OR ');
  const bindings = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
  const result = await env.DB.prepare(
    `SELECT title, content, content_translated, url, published_at, extra FROM items
     WHERE is_relevant = 1 AND deleted_at IS NULL AND url IS NOT NULL AND (${predicates})
     ORDER BY COALESCE(published_at, scraped_at) DESC LIMIT 8`,
  ).bind(...bindings).all<SearchRow>();
  return (result.results || []).filter((row) => !!row.url).map((row) => {
    const extra = parseObject(row.extra);
    const identity = sourceIdentity(row.url!);
    return {
      url: row.url!,
      title: compact(extra.title_zh || row.title, 220),
      snippet: compact(extra.ai_summary_zh || extra.summary_zh || row.content_translated || row.content, 1_500),
      source_type: identity.source_type,
      publisher: compact(extra.source_company || identity.publisher, 120),
      published_at: row.published_at,
      reliable: identity.reliable,
    };
  });
}

export function createManualNewsLeadRuntimeAdapters(env: Env): ManualLeadProcessingAdapters {
  return {
    search: (input) => searchExistingNews(env, input),
    fetch: (url) => fetchPublicDocument(url),
    extract: (document, hint) => extractManualNewsEvidence(document, hint),
    async assess(prompt) {
      if (!env.DEEPSEEK_API_KEY) throw new Error('no_deepseek_key');
      const result = await callDeepSeekJson<unknown>(
        env.DEEPSEEK_API_KEY,
        DEEPSEEK_PRO,
        prompt.user,
        { systemPrompt: prompt.system, maxTokens: 3_500, timeoutMs: 120_000, retries: 1 },
      );
      if (!result.data) throw new Error(result.error || 'empty_model_assessment');
      return result.data;
    },
  };
}

export async function processManualNewsLeadWithEnv(env: Env, leadId: string): Promise<void> {
  const store = new D1ManualLeadProcessingStore(env);
  await processManualNewsLead(leadId, store, createManualNewsLeadRuntimeAdapters(env));
}

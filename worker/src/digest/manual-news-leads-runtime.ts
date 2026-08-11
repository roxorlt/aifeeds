import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import {
  fetchPublicDocument,
  searchPublicWeb,
  type PublicDocument,
  type TrustedGatewayFetcher,
  type TrustedResearchService,
} from '../security/safe-url-fetch';
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

const OFFICIAL_PRODUCT_DOMAINS = new Set([
  'anthropic.com', 'claude.com', 'openai.com', 'deepmind.google', 'blog.google',
  'meta.com', 'nvidia.com', 'microsoft.com', 'github.blog', 'huggingface.co',
]);
const ORIGINAL_DOCUMENT_DOMAINS = new Set([
  'senate.gov', 'house.gov', 'congress.gov', 'whitehouse.gov', 'ftc.gov', 'justice.gov',
]);
const INDEPENDENT_MEDIA_DOMAINS = new Set([
  'axios.com', 'reuters.com', 'apnews.com', 'theverge.com', 'techcrunch.com', 'bloomberg.com',
  'wsj.com', 'nytimes.com', 'ft.com', 'jiqizhixin.com', 'qbitai.com', '36kr.com',
]);

function allowlistedRegistrableDomain(host: string, domains: ReadonlySet<string>): string | null {
  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) return domain;
  }
  return null;
}

function displayRegistrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean);
  return labels.length > 1 ? labels.slice(-2).join('.') : host;
}

function sourceIdentity(urlValue: string): { source_type: ManualEvidenceSourceType; reliable: boolean; publisher: string } {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return { source_type: 'other', reliable: false, publisher: '' };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const original = allowlistedRegistrableDomain(host, ORIGINAL_DOCUMENT_DOMAINS);
  if (original) return { source_type: 'original_document', reliable: true, publisher: original };
  const official = allowlistedRegistrableDomain(host, OFFICIAL_PRODUCT_DOMAINS);
  if (official) {
    const prefix = host.slice(0, Math.max(0, host.length - official.length)).replace(/\.$/, '');
    const help = prefix.split('.').some((label) => ['support', 'help', 'docs'].includes(label));
    return { source_type: help ? 'official_help' : 'official_primary', reliable: true, publisher: official };
  }
  const independent = allowlistedRegistrableDomain(host, INDEPENDENT_MEDIA_DOMAINS);
  if (independent) return { source_type: 'independent_media', reliable: true, publisher: independent };
  return { source_type: 'other', reliable: false, publisher: displayRegistrableDomain(host) };
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
  const candidates: string[] = [];
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
  if (hinted) candidates.push(hinted);
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
  const html = document.extraction === 'html';
  const titleMatch = html ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(document.body) : null;
  const title = compact(hint?.title || (titleMatch ? decodeHtml(titleMatch[1]) : ''), 220);
  const excerpt = compact(html ? decodeHtml(document.body) : document.body, 3_000);
  if (!title && !excerpt) return null;
  return {
    id: await evidenceId(document.url),
    url: document.url,
    source_type: identity.source_type,
    publisher: compact(identity.publisher, 120),
    published_at: normalizedPublishedAt(document.body, hint?.published_at),
    retrieved_at: now,
    title,
    excerpt,
    claims_supported: excerpt ? [excerpt] : [],
    reliable: identity.reliable,
    fetch_audit: document.fetch_audit,
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

function researchService(env: Env, fetcher?: TrustedGatewayFetcher): TrustedResearchService | undefined {
  if (!env.MANUAL_NEWS_RESEARCH_ORIGIN || !env.MANUAL_NEWS_RESEARCH_TOKEN) return undefined;
  return {
    origin: env.MANUAL_NEWS_RESEARCH_ORIGIN,
    token: env.MANUAL_NEWS_RESEARCH_TOKEN,
    ...(fetcher ? { fetcher } : {}),
  };
}

async function searchAllNews(
  env: Env,
  input: { date: string; text: string },
  fetcher?: TrustedGatewayFetcher,
): Promise<ManualSearchResult[]> {
  // Open-web research is mandatory for text clues. D1 is useful context but is
  // not treated as proof that broader research completed.
  const [existing, openWeb] = await Promise.all([
    searchExistingNews(env, input),
    searchPublicWeb(input, { service: researchService(env, fetcher) }),
  ]);
  const combined: ManualSearchResult[] = [...existing, ...openWeb];
  return combined.filter((item, index) => combined.findIndex((candidate) => candidate.url === item.url) === index).slice(0, 8);
}

export function createManualNewsLeadRuntimeAdapters(
  env: Env,
  deps: { researchFetcher?: TrustedGatewayFetcher } = {},
): ManualLeadProcessingAdapters {
  return {
    search: (input) => searchAllNews(env, input, deps.researchFetcher),
    fetch: (url) => fetchPublicDocument(url, { service: researchService(env, deps.researchFetcher) }),
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

export async function processManualNewsLeadWithEnv(env: Env, leadId: string, processingOwner?: string): Promise<void> {
  const store = new D1ManualLeadProcessingStore(env, processingOwner);
  await processManualNewsLead(leadId, store, createManualNewsLeadRuntimeAdapters(env));
}

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
import {
  classifyManualNewsProviderErrorCode,
  ManualNewsProviderError,
  manualNewsProviderDiagnostics,
  type ManualNewsProviderCallContext,
  type ManualNewsProviderCallMetrics,
  type ManualNewsProviderStage,
} from './manual-news-provider';

export const MANUAL_NEWS_PROVIDER_TIMEOUT_MS = 210_000;
export const MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS = 64_000;

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

function safeSearchError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/https?:\/\/\S+/gi, '[url]');
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return compact(message.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]'), 300) || 'unknown_error';
}

async function withSearchStage<T>(
  stage: 'search_existing' | 'search_public',
  operation: () => Promise<T>,
  secrets: readonly string[] = [],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${stage}:${safeSearchError(error, secrets)}`);
  }
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

const MANUAL_NEWS_EXCERPT_MAX_CHARS = 3_000;
const MANUAL_NEWS_JSON_LD_MAX_CHARS = 256_000;
const MANUAL_NEWS_ARTICLE_BODY_MAX_CHARS = 100_000;
const MANUAL_NEWS_JSON_LD_MAX_DEPTH = 12;
const MANUAL_NEWS_JSON_LD_MAX_NODES = 1_000;
const MANUAL_NEWS_HTML_MAX_CODE_UNITS = 2_000_000;
const MANUAL_NEWS_HTML_MAX_TOKENS = 100_000;
const MANUAL_NEWS_HTML_MAX_TAG_CODE_UNITS = 65_536;
const MANUAL_NEWS_HTML_MAX_DEPTH = 128;
const MANUAL_NEWS_HTML_MAX_CANDIDATE_DEPTH = 16;
const MANUAL_NEWS_HTML_MAX_BODY_CANDIDATES = 256;
const MANUAL_NEWS_HTML_MAX_JSON_LD_SCRIPTS = 32;

const HTML_HIDDEN_CONTAINERS = new Set([
  'canvas', 'math', 'object', 'svg', 'template',
]);
const HTML_FOREIGN_SELF_CLOSING_CONTAINERS = new Set(['math', 'svg']);
// These tokenizer states consume everything up to their own matching end tag.
// Treat noscript as raw and hidden conservatively: its browser semantics depend
// on whether scripting is enabled, while neither branch is article evidence.
const HTML_RAW_HIDDEN_ELEMENTS = new Set([
  'iframe', 'noembed', 'noframes', 'noscript', 'script', 'style', 'xmp',
]);
const HTML_RCDATA_ELEMENTS = new Set(['textarea', 'title']);

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/&#(\d{1,7});/g, (entity, decimal: string) => {
      const codePoint = Number(decimal);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&#x([\da-f]{1,6});/gi, (entity, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
}

function htmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '(?:^|\\s)' + escaped + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))';
  const match = new RegExp(pattern, 'i').exec(attributes);
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

interface HtmlBodyCandidate {
  tag: 'article' | 'main';
  parts: string[];
}

interface HtmlEvidenceScan {
  reliable: boolean;
  title_text: string;
  visible_text: string;
  json_ld_sources: string[];
  article_bodies: string[];
  main_bodies: string[];
}

function normalizedHtmlParts(parts: readonly string[]): string {
  return decodeHtmlEntities(parts.join('')).replace(/\s+/g, ' ').trim();
}

function findHtmlTagEnd(html: string, start: number): number | null {
  let quote = '';
  const limit = Math.min(html.length, start + MANUAL_NEWS_HTML_MAX_TAG_CODE_UNITS);
  for (let index = start; index < limit; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return null;
}

function isHtmlTagBoundary(character: string | undefined): boolean {
  return character === undefined || character === '>' || character === '/' || /\s/.test(character);
}

function findRawHtmlClosing(
  html: string,
  lowerHtml: string,
  tag: string,
  from: number,
): { start: number; end: number } | null {
  const prefix = `</${tag}`;
  let searchFrom = from;
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    const start = lowerHtml.indexOf(prefix, searchFrom);
    if (start < 0) return null;
    if (isHtmlTagBoundary(lowerHtml[start + prefix.length])) {
      const end = findHtmlTagEnd(html, start + prefix.length);
      // Once an appropriate raw-text end tag starts, malformed/unbounded
      // attributes make the tokenizer state ambiguous. Do not scan through
      // them and accidentally activate later markup.
      if (end === null) return null;
      return { start, end };
    }
    searchFrom = start + prefix.length;
  }
  return null;
}

function scanHtmlEvidence(html: string, collectStructured = true): HtmlEvidenceScan {
  const visibleParts: string[] = [];
  const jsonLdSources: string[] = [];
  const articleBodies: string[] = [];
  const mainBodies: string[] = [];
  const hiddenStack: string[] = [];
  const candidateStack: HtmlBodyCandidate[] = [];
  if (html.length > MANUAL_NEWS_HTML_MAX_CODE_UNITS) {
    return {
      reliable: false, title_text: '', visible_text: '',
      json_ld_sources: [], article_bodies: [], main_bodies: [],
    };
  }
  const lowerHtml = html.toLowerCase();
  let index = 0;
  let tokens = 0;
  let reliable = true;
  let titleText = '';
  const hidden = () => hiddenStack.length > 0;
  const appendVisible = (text: string) => {
    if (!text || hidden()) return;
    visibleParts.push(text);
    for (const candidate of candidateStack) candidate.parts.push(text);
  };
  const fail = () => {
    reliable = false;
    index = html.length;
  };

  while (index < html.length && reliable) {
    tokens += 1;
    if (tokens > MANUAL_NEWS_HTML_MAX_TOKENS
      || hiddenStack.length > MANUAL_NEWS_HTML_MAX_DEPTH
      || candidateStack.length > MANUAL_NEWS_HTML_MAX_CANDIDATE_DEPTH) {
      fail();
      break;
    }
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      if (end < 0) {
        fail();
        break;
      }
      appendVisible(' ');
      index = end + 3;
      continue;
    }
    if (html[index] !== '<') {
      const nextTag = html.indexOf('<', index);
      const end = nextTag < 0 ? html.length : nextTag;
      appendVisible(html.slice(index, end));
      index = end;
      continue;
    }
    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = findHtmlTagEnd(html, index + 2);
      if (end === null) {
        fail();
        break;
      }
      appendVisible(' ');
      index = end + 1;
      continue;
    }

    let cursor = index + 1;
    let closing = false;
    if (html[cursor] === '/') {
      closing = true;
      cursor += 1;
      while (/\s/.test(html[cursor] || '')) cursor += 1;
    }
    const nameStart = cursor;
    while (/[A-Za-z0-9:-]/.test(html[cursor] || '')) cursor += 1;
    if (cursor === nameStart || !/[A-Za-z]/.test(html[nameStart])) {
      appendVisible('<');
      index += 1;
      continue;
    }
    const tag = lowerHtml.slice(nameStart, cursor);
    const tagEnd = findHtmlTagEnd(html, cursor);
    if (tagEnd === null) {
      fail();
      break;
    }
    const attributes = html.slice(cursor, tagEnd);
    const selfClosing = !closing && attributes.trimEnd().endsWith('/');

    if (closing) {
      if (HTML_HIDDEN_CONTAINERS.has(tag)) {
        if (!hiddenStack.length) {
          index = tagEnd + 1;
          continue;
        }
        if (hiddenStack[hiddenStack.length - 1] !== tag) {
          fail();
          break;
        }
        hiddenStack.pop();
        appendVisible(' ');
      } else if ((tag === 'article' || tag === 'main') && !hidden()) {
        const matchingIndex = candidateStack.map((candidate) => candidate.tag).lastIndexOf(tag);
        if (matchingIndex >= 0 && matchingIndex !== candidateStack.length - 1) {
          fail();
          break;
        }
        if (matchingIndex >= 0) {
          appendVisible(' ');
          const candidate = candidateStack.pop()!;
          const body = normalizedHtmlParts(candidate.parts);
          const target = candidate.tag === 'article' ? articleBodies : mainBodies;
          if (body) {
            if (target.length >= MANUAL_NEWS_HTML_MAX_BODY_CANDIDATES) {
              fail();
              break;
            }
            target.push(body);
          }
        }
      } else {
        appendVisible(' ');
      }
      index = tagEnd + 1;
      continue;
    }

    // HTML switches permanently to the plaintext tokenizer state here. There
    // is no closing tag and no later structure can safely become evidence.
    if (tag === 'plaintext') {
      fail();
      break;
    }

    if (HTML_RAW_HIDDEN_ELEMENTS.has(tag) || HTML_RCDATA_ELEMENTS.has(tag)) {
      const rawClosing = findRawHtmlClosing(html, lowerHtml, tag, tagEnd + 1);
      if (!rawClosing) {
        fail();
        break;
      }
      const rawText = html.slice(tagEnd + 1, rawClosing.start);
      if (tag === 'script') {
        const type = htmlAttribute(attributes, 'type')?.split(';', 1)[0].trim().toLowerCase();
        if (collectStructured && !hidden() && type === 'application/ld+json'
          && rawText.trim() && Array.from(rawText).length <= MANUAL_NEWS_JSON_LD_MAX_CHARS) {
          if (jsonLdSources.length >= MANUAL_NEWS_HTML_MAX_JSON_LD_SCRIPTS) {
            fail();
            break;
          }
          jsonLdSources.push(rawText.trim());
        }
      } else if (tag === 'title' && !hidden()) {
        if (!titleText) titleText = decodeHtmlEntities(rawText).replace(/\s+/g, ' ').trim();
        appendVisible(` ${rawText} `);
      }
      appendVisible(' ');
      index = rawClosing.end + 1;
      continue;
    }

    if (HTML_HIDDEN_CONTAINERS.has(tag)) {
      appendVisible(' ');
      if (!selfClosing || !HTML_FOREIGN_SELF_CLOSING_CONTAINERS.has(tag)) hiddenStack.push(tag);
      index = tagEnd + 1;
      continue;
    }
    if ((tag === 'article' || tag === 'main') && !hidden() && !selfClosing) {
      candidateStack.push({ tag, parts: [] });
    }
    appendVisible(' ');
    index = tagEnd + 1;
  }

  if (hiddenStack.length || candidateStack.length) reliable = false;
  return {
    reliable,
    title_text: reliable ? titleText : '',
    visible_text: reliable ? normalizedHtmlParts(visibleParts) : '',
    json_ld_sources: reliable ? jsonLdSources : [],
    article_bodies: reliable ? articleBodies : [],
    main_bodies: reliable ? mainBodies : [],
  };
}

function decodeHtml(value: string): string {
  const scan = scanHtmlEvidence(value, false);
  return scan.reliable ? scan.visible_text : '';
}

function isJsonLdArticleType(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isJsonLdArticleType);
  if (typeof value !== 'string') return false;
  const type = value.trim().toLowerCase().replace(/[#/]$/, '').split(/[#/]/).pop();
  return type === 'article' || type === 'newsarticle';
}

function boundedArticleText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const size = Array.from(value).length;
  if (size < 20 || size > MANUAL_NEWS_ARTICLE_BODY_MAX_CHARS) return null;
  const decoded = decodeHtml(value);
  return Array.from(decoded).length >= 20 ? decoded : null;
}

function jsonLdArticleBody(value: unknown): string | null {
  let visited = 0;
  const visit = (node: unknown, depth: number): string | null => {
    visited += 1;
    if (visited > MANUAL_NEWS_JSON_LD_MAX_NODES || depth > MANUAL_NEWS_JSON_LD_MAX_DEPTH) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const body = visit(item, depth + 1);
        if (body) return body;
      }
      return null;
    }
    if (!node || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;
    if (isJsonLdArticleType(record['@type'])) {
      const body = boundedArticleText(record.articleBody);
      if (body) return body;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'articleBody' || key === '@context') continue;
      const body = visit(child, depth + 1);
      if (body) return body;
    }
    return null;
  };
  return visit(value, 0);
}

function extractJsonLdArticleBody(sources: readonly string[]): string | null {
  for (const source of sources) {
    try {
      const body = jsonLdArticleBody(JSON.parse(source));
      if (body) return body;
    } catch {
      // Invalid structured data is untrusted and falls through to the bounded HTML containers.
    }
  }
  return null;
}

function longestBoundedBody(candidates: readonly string[]): string | null {
  return candidates
    .map((candidate) => {
      const size = Array.from(candidate).length;
      return size >= 20 && size <= MANUAL_NEWS_ARTICLE_BODY_MAX_CHARS ? candidate : null;
    })
    .filter((candidate): candidate is string => !!candidate)
    .sort((left, right) => Array.from(right).length - Array.from(left).length)[0] || null;
}

function preferredHtmlEvidence(html: string): { title: string; text: string } | null {
  const scan = scanHtmlEvidence(html);
  if (!scan.reliable) return null;
  return {
    title: scan.title_text,
    text: extractJsonLdArticleBody(scan.json_ld_sources)
      || longestBoundedBody(scan.article_bodies)
      || longestBoundedBody(scan.main_bodies)
      || scan.visible_text,
  };
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
  const htmlEvidence = html ? preferredHtmlEvidence(document.body) : null;
  if (html && htmlEvidence === null) return null;
  const title = compact(hint?.title || htmlEvidence?.title || '', 220);
  const extractedBody = htmlEvidence?.text ?? document.body;
  const excerpt = compact(extractedBody, MANUAL_NEWS_EXCERPT_MAX_CHARS);
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
    withSearchStage('search_existing', () => searchExistingNews(env, input)),
    withSearchStage(
      'search_public',
      () => searchPublicWeb(input, { service: researchService(env, fetcher) }),
      [env.MANUAL_NEWS_RESEARCH_TOKEN || ''],
    ),
  ]);
  const combined: ManualSearchResult[] = [...existing, ...openWeb];
  return combined.filter((item, index) => combined.findIndex((candidate) => candidate.url === item.url) === index).slice(0, 8);
}

export function createManualNewsLeadRuntimeAdapters(
  env: Env,
  deps: {
    researchFetcher?: TrustedGatewayFetcher;
    modelContext?: { leadId: string; processingAttempt: number };
  } = {},
): ManualLeadProcessingAdapters {
  let fallbackCallSequence = 0;
  const callProJson = (stage: ManualNewsProviderStage) => async (
    prompt: { system: string; user: string },
    context?: ManualNewsProviderCallContext,
  ): Promise<unknown> => {
    if (!env.DEEPSEEK_API_KEY) throw new Error('no_deepseek_key');
    fallbackCallSequence += 1;
    const fallbackAttempt = deps.modelContext?.processingAttempt || 0;
    const metrics: ManualNewsProviderCallMetrics = {
      stage,
      request_id: context?.request_id
        || `${deps.modelContext?.leadId || 'manual-news-unscoped'}:p${fallbackAttempt}:${stage}:${fallbackCallSequence}`,
      system_chars: Array.from(prompt.system).length,
      user_chars: Array.from(prompt.user).length,
      evidence_count: context?.evidence_count || 0,
      attempt: context?.attempt ?? fallbackAttempt,
    };
    console.info('[manual-news-provider-call]', JSON.stringify(metrics));
    const serializedPromptChars = Array.from(JSON.stringify({
      system: prompt.system,
      user: prompt.user,
    })).length;
    if (serializedPromptChars > MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS) {
      throw new ManualNewsProviderError({
        stage,
        provider_error_code: 'provider_prompt_too_large',
        metrics,
      });
    }
    const result = await callDeepSeekJson<unknown>(
      env.DEEPSEEK_API_KEY,
      DEEPSEEK_PRO,
      prompt.user,
      {
        systemPrompt: prompt.system,
        maxTokens: 12_000,
        timeoutMs: MANUAL_NEWS_PROVIDER_TIMEOUT_MS,
        retries: 0,
        requestId: metrics.request_id,
      },
    );
    if (!result.data) {
      const providerDiagnostics = manualNewsProviderDiagnostics(result.diagnostics);
      throw new ManualNewsProviderError({
        stage,
        provider_error_code: classifyManualNewsProviderErrorCode(
          result.error || 'no_text', providerDiagnostics,
        ),
        metrics,
        provider_diagnostics: providerDiagnostics,
      });
    }
    return result.data;
  };
  return {
    search: (input) => searchAllNews(env, input, deps.researchFetcher),
    fetch: (url) => fetchPublicDocument(url, { service: researchService(env, deps.researchFetcher) }),
    extract: (document, hint) => extractManualNewsEvidence(document, hint),
    assess: callProJson('assessment'),
    verify: callProJson('verification'),
  };
}

export async function processManualNewsLeadWithEnv(
  env: Env,
  leadId: string,
  processingOwner?: string,
  processingAttempt?: number,
): Promise<void> {
  const store = new D1ManualLeadProcessingStore(env, processingOwner, processingAttempt);
  await processManualNewsLead(leadId, store, createManualNewsLeadRuntimeAdapters(env, {
    modelContext: { leadId, processingAttempt: processingAttempt || 0 },
  }));
}

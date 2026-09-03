import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import {
  deriveManualNewsRetrievalOperationId,
  fetchPublicDocument,
  fetchTweetEvidence,
  isTweetEvidenceAudit,
  parseTwitterStatusUrl,
  validateCompleteArticleText,
  searchPublicWeb,
  type PublicDocument,
  type DocumentFetchAudit,
  type ProviderRetrievalAudit,
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
const TRUSTED_WECHAT_INDEPENDENT_PUBLISHERS = new Map([
  ['机器之心\0MzA3MzI4MjgzMw==', 'jiqizhixin.com'],
]);

function trustedWeChatIndependentPublisher(document: PublicDocument): string | undefined {
  if (document.fetch_audit.protocol_version !== 'provider_retrieval_v1' || !document.publisher) return undefined;
  try {
    const accountId = new URL(document.url).searchParams.get('__biz') || '';
    return TRUSTED_WECHAT_INDEPENDENT_PUBLISHERS.get(`${document.publisher}\0${accountId}`);
  } catch {
    return undefined;
  }
}

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

const MANUAL_NEWS_EXCERPT_MAX_BYTES = 12_000;
const MANUAL_NEWS_EXCERPT_MAX_CHARACTERS = 3_000;

function normalizedHintPublishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function completeTrustedArticle(document: PublicDocument): Promise<boolean> {
  const providerRetrieval = document.fetch_audit.protocol_version === 'provider_retrieval_v1';
  const audit = document.fetch_audit as DocumentFetchAudit | ProviderRetrievalAudit;
  const fullTextBytes = audit.actual_sizes.extracted_text_bytes;
  const fullTextCodePoints = audit.actual_sizes.extracted_text_characters;
  if (providerRetrieval) {
    const providerAudit = audit as ProviderRetrievalAudit;
    if (document.extraction !== 'provider_article_text'
      || document.content_type !== 'text/plain'
      || document.content_complete !== true
      || document.title !== providerAudit.title
      || document.publisher !== providerAudit.publisher
      || document.published_at !== providerAudit.published_at
      || document.url !== providerAudit.canonical_original_url
      || providerAudit.retrieval_type !== 'provider'
      || providerAudit.provider_id !== 'redfox_gzh_article_content_v1'
      || !/^[a-f0-9]{64}$/.test(providerAudit.operation_id)
      || !providerAudit.identity_assertion
      || Object.keys(providerAudit.identity_assertion).length !== 8
      || providerAudit.identity_assertion.contract !== 'provider_asserted_wechat_article_identity_v1'
      || providerAudit.identity_assertion.requested_url !== providerAudit.input_url
      || providerAudit.identity_assertion.requested_short_url
        !== (new URL(providerAudit.input_url).pathname === '/s' ? null : providerAudit.input_url)
      || providerAudit.identity_assertion.provider_asserted_source_url !== providerAudit.canonical_original_url
      || providerAudit.identity_assertion.provider_asserted_canonical_url !== providerAudit.canonical_original_url
      || providerAudit.identity_assertion.provider_asserted_publisher !== providerAudit.publisher
      || providerAudit.identity_assertion.provider_asserted_wechat_biz
        !== new URL(providerAudit.canonical_original_url).searchParams.get('__biz')
      || providerAudit.identity_assertion.assurance !== 'provider_assertion_not_independently_verified'
      || providerAudit.response_profile !== 'proof_excerpt_v1'
      || providerAudit.response_hmac_contract !== 'hmac-sha256-domain-separated-canonical-json-all-fields-except-response_hmac-v1'
      || !/^(?:[a-f0-9]{32,128}|[A-Za-z0-9_-]{22,171})$/.test(providerAudit.request_nonce)
      || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(providerAudit.request_timestamp)
      || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(providerAudit.response_created_at)
      || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(providerAudit.provider_retrieved_at)
      || !/^[a-f0-9]{64}$/.test(providerAudit.body_sha256)
      || !/^[a-f0-9]{64}$/.test(providerAudit.response_hmac)
      || providerAudit.limits.extracted_text_bytes !== 28_000
      || providerAudit.limits.extracted_text_characters !== 28_000
      || fullTextBytes <= 0 || fullTextBytes > providerAudit.limits.extracted_text_bytes
      || fullTextCodePoints <= 0 || fullTextCodePoints > providerAudit.limits.extracted_text_characters) return false;
  }
  const directAudit = audit as DocumentFetchAudit;
  if (!providerRetrieval && (document.extraction !== 'article_text'
    || !['text/html', 'application/xhtml+xml'].includes(document.content_type)
    || document.content_complete !== true
    || typeof document.title !== 'string' || !document.title.trim()
    || !['article', 'main'].includes(String(document.selection))
    || !directAudit.document
    || directAudit.document.title !== document.title
    || directAudit.document.published_at !== document.published_at
    || directAudit.document.selection !== document.selection
    || directAudit.document.content_complete !== true
    || directAudit.extraction !== 'article_text'
    || directAudit.protocol_version !== 'article_text_v2'
    || directAudit.response_profile !== 'proof_excerpt_v1'
    || directAudit.response_hmac_contract !== 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1'
    || !directAudit.proof_excerpt
    || Object.keys(directAudit.proof_excerpt).length !== 6
    || !Object.keys(directAudit.proof_excerpt).every((key) => [
      'contract', 'algorithm', 'max_code_points', 'sha256', 'utf8_bytes', 'code_points',
    ].includes(key))
    || directAudit.proof_excerpt?.contract !== 'proof_excerpt_v1'
    || directAudit.proof_excerpt?.algorithm !== 'utf8-nfc-ws1-codepoint-prefix-v1'
    || directAudit.proof_excerpt?.max_code_points !== 3_000
    || directAudit.final_url !== document.url
    || !/^(?:[a-f0-9]{32,128}|[A-Za-z0-9_-]{22,171})$/.test(directAudit.request_nonce || '')
    || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(directAudit.request_timestamp || '')
    || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(directAudit.extracted_at || '')
    || !/^[a-f0-9]{64}$/.test(directAudit.body_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(directAudit.response_hmac || '')
    || !/^chromium\/(\d+)\.\d+\.\d+\.\d+$/.test(directAudit.parser.version)
    || Number(/^chromium\/(\d+)/.exec(directAudit.parser.version)?.[1] || 0) < 149
    || fullTextBytes <= 0 || fullTextBytes > 28_000
    || fullTextCodePoints <= 0 || fullTextCodePoints > 28_000
    || fullTextBytes > directAudit.applied_limits.extracted_text_bytes
    || fullTextCodePoints > directAudit.applied_limits.extracted_text_characters
    || directAudit.truncation.source || directAudit.truncation.extracted_text)) return false;
  const proofExcerpt = audit.proof_excerpt;
  const bytes = new TextEncoder().encode(document.excerpt).byteLength;
  const characters = Array.from(document.excerpt);
  if (!characters.length
    || bytes > MANUAL_NEWS_EXCERPT_MAX_BYTES
    || characters.length > MANUAL_NEWS_EXCERPT_MAX_CHARACTERS
    || !proofExcerpt
    || proofExcerpt.utf8_bytes !== bytes
    || proofExcerpt.code_points !== characters.length) return false;
  try {
    validateCompleteArticleText(document.excerpt, bytes);
  } catch {
    return false;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.excerpt));
  const excerptHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return excerptHash === proofExcerpt.sha256;
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
  // 推文证据(2026-09-03):走 /v1/tweet 取回,来源标注要与网页证据可区分。
  // source_type 仍是 'other' / reliable=false —— 一条推文的权威性取决于**账号**而不是域名,
  // x.com 这个 host 本身不构成一手信源。这是有意的:推文能进证据链、能被 owner 看到,
  // 但不会自动把线索抬进「一手/独立」档位。
  if (isTweetEvidenceAudit(document.fetch_audit)) {
    const audit = document.fetch_audit;
    const handle = parseTwitterStatusUrl(audit.canonical_url)?.handle || '';
    const excerpt = document.excerpt;
    if (!excerpt.trim()) return null;
    return {
      id: await evidenceId(audit.canonical_url),
      response_key_id: document.response_key_id,
      url: audit.canonical_url,
      source_type: 'other',
      publisher: compact(handle ? `X @${handle}` : 'X/Twitter 推文', 120),
      published_at: document.published_at ?? null,
      retrieved_at: now,
      title: compact(document.title || (handle ? `X @${handle} 的推文` : 'X/Twitter 推文'), 220),
      excerpt,
      claims_supported: [excerpt],
      reliable: false,
      fetch_audit: audit,
    };
  }
  const providerPublisher = trustedWeChatIndependentPublisher(document);
  const identity = providerPublisher
    ? { source_type: 'independent_media' as const, reliable: true, publisher: providerPublisher }
    : sourceIdentity(document.url);
  if (document.extraction === 'html') return null;
  if (['article_text', 'provider_article_text'].includes(document.extraction)
    && !await completeTrustedArticle(document)) return null;
  const articleText = document.extraction === 'article_text' || document.extraction === 'provider_article_text';
  const title = articleText ? document.title! : compact(hint?.title || '', 220);
  const excerpt = document.excerpt;
  if (!title && !excerpt) return null;
  return {
    id: await evidenceId(document.url),
    response_key_id: document.response_key_id,
    url: document.url,
    source_type: identity.source_type,
    publisher: compact(document.publisher || identity.publisher, 120),
    published_at: articleText ? document.published_at! : normalizedHintPublishedAt(hint?.published_at),
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
  if (!env.MANUAL_NEWS_RESEARCH_ORIGIN || !env.MANUAL_NEWS_RESEARCH_TOKEN
    || !env.MANUAL_NEWS_RESEARCH_RESPONSE_SECRET
    || !env.MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID) return undefined;
  return {
    origin: env.MANUAL_NEWS_RESEARCH_ORIGIN,
    token: env.MANUAL_NEWS_RESEARCH_TOKEN,
    responseKeyId: env.MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID,
    responseSecret: env.MANUAL_NEWS_RESEARCH_RESPONSE_SECRET,
    responseKeyringJson: env.MANUAL_NEWS_RESEARCH_RESPONSE_KEYRING_JSON,
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
    fetch: async (url, context) => {
      const retrievalOperationId = await deriveManualNewsRetrievalOperationId(url);
      if (retrievalOperationId && !Number.isSafeInteger(context?.retrieval_generation)) {
        throw new Error('provider_retrieval_generation_required');
      }
      return fetchPublicDocument(url, {
        service: researchService(env, deps.researchFetcher),
        ...(retrievalOperationId ? {
          retrievalOperationId,
          retrievalGeneration: context!.retrieval_generation,
        } : {}),
      });
    },
    fetchTweet: async (url) => {
      const tweet = await fetchTweetEvidence(url, { service: researchService(env, deps.researchFetcher) });
      // 把推文取证结果整形成 PublicDocument,好让证据链后续环节零改动地消费它。
      return {
        url: tweet.canonical_url,
        content_type: 'application/json',
        extraction: 'tweet_api',
        excerpt: tweet.text,
        redirects: 0,
        fetch_audit: tweet.fetch_audit,
        response_key_id: tweet.response_key_id,
        title: tweet.author || (tweet.author_handle ? `X @${tweet.author_handle}` : ''),
        publisher: tweet.author_handle ? `X @${tweet.author_handle}` : 'X/Twitter 推文',
        // 用推文自己的发布时间,不用取证时刻。
        published_at: tweet.published_at,
      };
    },
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

import { parseManualNewsKeyring } from './manual-news-keyring';

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARACTERS = 1_000_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_SEARCH_MAX_BYTES = 256 * 1024;
const ARTICLE_TEXT_MAX_BYTES = 28_000;
const ARTICLE_TEXT_MAX_CHARACTERS = 28_000;
const ARTICLE_TEXT_PROTOCOL_V2 = 'article_text_v2';
const PROOF_EXCERPT_RESPONSE_PROFILE = 'proof_excerpt_v1';
const PROOF_EXCERPT_RESPONSE_HMAC_CONTRACT = 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1';
const PROOF_EXCERPT_CONTRACT = 'proof_excerpt_v1';
const PROOF_EXCERPT_ALGORITHM = 'utf8-nfc-ws1-codepoint-prefix-v1';
const PROOF_EXCERPT_MAX_CODE_POINTS = 3_000;
const PROOF_EXCERPT_MAX_UTF8_BYTES = 12_000;
const ARTICLE_TEXT_V2_MAX_SKEW_MS = 5 * 60_000;
const ARTICLE_TEXT_V2_MAX_FUTURE_MS = 30_000;
const ARTICLE_TEXT_V2_MIN_CHROMIUM_MAJOR = 149;
const PROVIDER_RETRIEVAL_PROTOCOL = 'provider_retrieval_v1';
const REDFOX_PROVIDER_ID = 'redfox_gzh_article_content_v1';
const PROVIDER_RESPONSE_HMAC_CONTRACT = 'hmac-sha256-domain-separated-canonical-json-all-fields-except-response_hmac-v1';
const PROVIDER_HMAC_DOMAIN = 'aifeeds-provider-retrieval-v1\0';
const REDFOX_OPERATION_DOMAIN = 'aifeeds-redfox-operation-v1\0';
const MANUAL_NEWS_RETRIEVAL_OPERATION_DOMAIN = 'aifeeds-manual-news-retrieval-operation-v1\0';
const REDFOX_IDENTITY_ASSERTION_CONTRACT = 'provider_asserted_wechat_article_identity_v1';
const REDFOX_IDENTITY_ASSERTION_ASSURANCE = 'provider_assertion_not_independently_verified';
const PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_IMAGE_MAX_COUNT = 64;
const FROZEN_REDFOX_SHORT_ASSERTIONS = new Map([
  ['https://mp.weixin.qq.com/s/a0kOMCJ78T8GlQ8dJ_fUDw', {
    canonical_url: 'https://mp.weixin.qq.com/s?__biz=MzA3MzI4MjgzMw==&mid=2651052842&idx=1&sn=b51e7dcdefdc1d5e9bd54f005456bc19',
    publisher: '机器之心',
    wechat_biz: 'MzA3MzI4MjgzMw==',
  }],
]);

const ALLOWED_SOURCE_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/pdf',
]);

export type TrustedGatewayFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TrustedResearchService {
  /** Exact HTTPS origin of the peer-pinning research gateway. Paths, query, and fragments are forbidden. */
  origin: string;
  /** Server-side token. It is never returned to or accepted from browser/user input. */
  token: string;
  /** Independent 32-byte hex key used only to authenticate document responses. */
  responseSecret?: string;
  /** Explicit ID for the current response key plus optional retained historical keys. */
  responseKeyId?: string;
  responseKeyringJson?: string;
  fetcher?: TrustedGatewayFetcher;
  /** Test seams; production callers leave these unset. */
  protocolNow?: () => number;
  nonceFactory?: () => string;
}

export interface PublicDocument {
  url: string;
  content_type: string;
  extraction: 'html' | 'article_text' | 'provider_article_text' | 'tweet_api' | 'text' | 'json' | 'pdf_text';
  excerpt: string;
  redirects: number;
  fetch_audit: ManualNewsFetchAudit;
  response_key_id: string;
  title?: string;
  publisher?: string;
  published_at?: string | null;
  selection?: 'article' | 'main';
  content_complete?: true;
}

export interface PublicWebSearchResult {
  url: string;
  title: string;
  snippet: string;
  published_at: string | null;
}

export interface FetchAuditHop {
  url: string;
  validated_ip: string;
  connected_ip: string;
}

export interface DocumentExtractionLimits {
  source_bytes: number;
  extracted_text_bytes: number;
  extracted_text_characters: number;
}

export interface DocumentFetchAudit {
  hops: FetchAuditHop[];
  source_content_type: string;
  extraction: 'html' | 'article_text' | 'text' | 'json' | 'pdf_text';
  requested_limits: DocumentExtractionLimits;
  applied_limits: DocumentExtractionLimits;
  actual_sizes: DocumentExtractionLimits;
  truncation: { source: boolean; extracted_text: boolean };
  parser: { result: 'success'; version: string };
  document?: {
    title: string;
    published_at: string | null;
    selection: 'article' | 'main';
    content_complete: true;
  };
  protocol_version?: 'article_text_v2';
  request_nonce?: string;
  request_timestamp?: string;
  extracted_at?: string;
  final_url?: string;
  body_sha256?: string;
  response_profile?: 'proof_excerpt_v1';
  response_hmac_contract?: 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1';
  proof_excerpt?: {
    contract: 'proof_excerpt_v1';
    algorithm: 'utf8-nfc-ws1-codepoint-prefix-v1';
    max_code_points: 3000;
    sha256: string;
    utf8_bytes: number;
    code_points: number;
  };
  response_hmac?: string;
}

export interface ProviderRetrievalAudit {
  retrieval_type: 'provider';
  provider_id: 'redfox_gzh_article_content_v1';
  operation_id: string;
  retrieval_operation_id?: string;
  retrieval_generation?: number;
  input_url: string;
  canonical_original_url: string;
  identity_assertion: {
    contract: 'provider_asserted_wechat_article_identity_v1';
    requested_url: string;
    requested_short_url: string | null;
    provider_asserted_source_url: string;
    provider_asserted_canonical_url: string;
    provider_asserted_publisher: string;
    provider_asserted_wechat_biz: string;
    assurance: 'provider_assertion_not_independently_verified';
  };
  title: string;
  publisher: string;
  published_at: string;
  provider_retrieved_at: string;
  cache_status: 'miss' | 'hit' | 'coalesced' | 'durable';
  limits: {
    provider_response_bytes: number;
    extracted_text_bytes: number;
    extracted_text_characters: number;
    image_count: number;
  };
  actual_sizes: {
    provider_response_bytes: number;
    extracted_text_bytes: number;
    extracted_text_characters: number;
    image_count: number;
  };
  protocol_version: 'provider_retrieval_v1';
  request_nonce: string;
  request_timestamp: string;
  response_created_at: string;
  body_sha256: string;
  response_profile: 'proof_excerpt_v1';
  response_hmac_contract: 'hmac-sha256-domain-separated-canonical-json-all-fields-except-response_hmac-v1';
  proof_excerpt: NonNullable<DocumentFetchAudit['proof_excerpt']>;
  response_hmac: string;
  /** Direct-fetch-only metadata is intentionally absent from provider evidence. */
  document?: never;
}

export type ManualNewsFetchAudit = DocumentFetchAudit | ProviderRetrievalAudit | TweetEvidenceAudit;

// ─────────────────────────────────────────────────────────────────────────────
// 推文取证（POST /v1/tweet）—— 2026-09-03
//
// 为什么是独立的一条路而不是复用 /v1/document:
// /v1/document 的 audit 断言「我按 DNS 解析拿到这个 IP、我连了这个 IP、正文来自它」,
// 每个 hop 都要 validated_ip === connected_ip 且是公网地址。推文取证走的是第三方 API
// (ScrapeBadger),根本不存在「连到 x.com 的某个 IP」这件事。把它塞进 /v1/document 只有
// 两条路:伪造 IP 字段(伪造一份会被 HMAC 签名的来源记录),或放宽对所有 URL 都生效的
// audit 校验。两条都不可接受,所以推文证据用自己的 audit 形状如实描述来源。
//
// 契约:dailyVideo 仓 docs/plans/2026-09-03-tweet-evidence-endpoint-contract.md
// ⚠️ 这里刻意**不复用** parseFetchAudit —— 它见到没有 hops 的 audit 会直接
// `unsafe_gateway_audit:invalid_schema` 拒掉。签名机制与文档 v2 路径同一套。
// ─────────────────────────────────────────────────────────────────────────────

const TWEET_EVIDENCE_PROTOCOL = 'tweet_evidence_v1';
const TWEET_EVIDENCE_PROVIDERS = new Set(['scrapebadger']);
/** audit.fetched_at 相对本地时钟的允许偏差,与文档 v2 路径同量级。 */
const TWEET_EVIDENCE_MAX_SKEW_MS = 5 * 60_000;
const TWEET_EVIDENCE_MAX_FUTURE_MS = 30_000;
const TWEET_EVIDENCE_MAX_BYTES = 512 * 1024;

export interface TweetEvidenceAudit {
  kind: 'tweet_api';
  provider: 'scrapebadger';
  tweet_id: string;
  requested_url: string;
  canonical_url: string;
  fetched_at: string;
  provider_status: number;
  // 云端始终带 nonce/timestamp 请求,网关必须回签名 audit,因此签名字段一律必填。
  // 未签名的 audit 在 parseTweetEvidenceAudit 里直接判为 signature_required。
  protocol_version: 'tweet_evidence_v1';
  request_nonce: string;
  request_timestamp: string;
  body_sha256: string;
  response_hmac: string;
  /** 直抓 / provider 专属字段绝不出现在推文证据里(也让联合类型上的属性访问可判别)。 */
  hops?: never;
  document?: never;
  proof_excerpt?: never;
  extraction?: never;
  retrieval_type?: never;
  final_url?: never;
  response_profile?: never;
  response_hmac_contract?: never;
}

export interface TweetEvidence {
  tweet_id: string;
  canonical_url: string;
  author: string;
  author_handle: string;
  /** 推文自己的发布时间,已归一成 ISO;无法解析时为 null。 */
  published_at: string | null;
  /** 提供方原样返回的发布时间字符串(Twitter 格式),留作证据原文。 */
  published_at_raw: string;
  language: string;
  text: string;
  images: string[];
  metrics: Record<string, number>;
  fetch_audit: TweetEvidenceAudit;
  response_key_id: string;
}

export interface TwitterStatusUrl {
  tweetId: string;
  handle: string;
  canonicalUrl: string;
}

/**
 * host 为 x.com / twitter.com（允许 www. / mobile. 前缀）、path 形如 /{user}/status/{数字 id}。
 * 与网关侧 parseTwitterStatusUrl 同一判定,是 pipeline 分流与 audit 校验共用的唯一口径。
 */
export function parseTwitterStatusUrl(input: string): TwitterStatusUrl | null {
  let url: URL;
  try { url = validatePublicHttpUrl(input); } catch { return null; }
  const host = normalizedHostname(url.hostname).replace(/^(?:www|mobile)\./, '');
  if (host !== 'x.com' && host !== 'twitter.com') return null;
  const match = /^\/([A-Za-z0-9_]{1,20})\/status\/(\d{1,25})\/?$/.exec(url.pathname);
  if (!match) return null;
  const [, handle, tweetId] = match;
  return { tweetId, handle, canonicalUrl: `https://x.com/${handle}/status/${tweetId}` };
}

/** 联合类型判别器:推文 audit 与直抓/provider audit 没有共用字段,用 kind 区分。 */
export function isTweetEvidenceAudit(
  audit: ManualNewsFetchAudit | null | undefined,
): audit is TweetEvidenceAudit {
  return (audit as { kind?: unknown } | null | undefined)?.kind === 'tweet_api';
}

export function isTwitterStatusUrl(input: string): boolean {
  return parseTwitterStatusUrl(input) !== null;
}

export async function verifyTweetEvidenceAuditResponseHmac(
  audit: TweetEvidenceAudit,
  responseSecret: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(responseSecret)
    || !/^[a-f0-9]{64}$/.test(audit.response_hmac || '')) return false;
  const { response_hmac: suppliedHmac, ...unsignedAudit } = audit;
  // 与 signV2DocumentAudit 逐字一致:无域分隔,对去掉 response_hmac 的整个对象做 canonicalJson。
  return verifyResponseHmac(responseSecret, unsignedAudit, suppliedHmac);
}

/**
 * 独立的 tweet audit 解析器 —— 与 parseFetchAudit 没有任何共用分支。
 * 校验:严格键集合、kind、provider 白名单、requested_url 与请求 URL 逐字一致、
 * canonical_url 是合法 x.com status 链接、tweet_id 与两个 URL 内的 id 一致、
 * fetched_at 是合法 ISO 且与本地时钟偏差合理;带签名时再验 HMAC 与 body 摘要。
 */
async function parseTweetEvidenceAudit(
  response: Response,
  requested: URL,
  bodyText: string,
  protocol: { nonce: string; requestTimestamp: string; now: number },
  responseKeys: { currentKeyId: string; keys: ReadonlyMap<string, string> },
): Promise<{ audit: TweetEvidenceAudit; responseKeyId: string }> {
  const encoded = response.headers.get('X-AIFeeds-Tweet-Audit') || '';
  if (!encoded || encoded.length > 8_192) throw new Error('unsafe_tweet_audit:missing');
  let raw: unknown;
  try { raw = JSON.parse(decodeURIComponent(encoded)); } catch { throw new Error('unsafe_tweet_audit:invalid_json'); }

  const baseKeys = ['kind', 'provider', 'tweet_id', 'requested_url', 'canonical_url', 'fetched_at', 'provider_status'];
  const signedKeys = [...baseKeys, 'protocol_version', 'request_nonce', 'request_timestamp', 'body_sha256', 'response_hmac'];
  const signed = strictObject(raw, signedKeys);
  if (!signed && !strictObject(raw, baseKeys)) throw new Error('unsafe_tweet_audit:invalid_schema');
  const audit = raw as Record<string, unknown>;

  if (audit.kind !== 'tweet_api') throw new Error('unsafe_tweet_audit:kind');
  if (typeof audit.provider !== 'string' || !TWEET_EVIDENCE_PROVIDERS.has(audit.provider)) {
    throw new Error('unsafe_tweet_audit:provider');
  }
  if (typeof audit.requested_url !== 'string' || audit.requested_url !== requested.toString()) {
    throw new Error('unsafe_tweet_audit:request_mismatch');
  }
  const canonical = typeof audit.canonical_url === 'string' ? parseTwitterStatusUrl(audit.canonical_url) : null;
  if (!canonical || canonical.canonicalUrl !== audit.canonical_url) {
    throw new Error('unsafe_tweet_audit:canonical_url');
  }
  const requestedStatus = parseTwitterStatusUrl(audit.requested_url);
  if (typeof audit.tweet_id !== 'string' || !/^\d{1,25}$/.test(audit.tweet_id)
    || audit.tweet_id !== canonical.tweetId
    || !requestedStatus || requestedStatus.tweetId !== audit.tweet_id) {
    throw new Error('unsafe_tweet_audit:tweet_id');
  }
  const fetchedAt = canonicalIsoTimestamp(audit.fetched_at);
  if (!fetchedAt
    || fetchedAt.timestamp > protocol.now + TWEET_EVIDENCE_MAX_FUTURE_MS
    || protocol.now - fetchedAt.timestamp > TWEET_EVIDENCE_MAX_SKEW_MS) {
    throw new Error('unsafe_tweet_audit:fetched_at');
  }
  if (typeof audit.provider_status !== 'number' || !Number.isSafeInteger(audit.provider_status)
    || audit.provider_status < 100 || audit.provider_status > 599) {
    throw new Error('unsafe_tweet_audit:provider_status');
  }

  // 云端始终带 nonce/timestamp 请求,因此网关必须回签名 audit。收到未签名的 audit 说明
  // 网关没配 response secret 或被中间人剥掉了签名 —— 两种都不能当作有效证据。
  if (!signed) throw new Error('unsafe_tweet_audit:signature_required');
  if (audit.protocol_version !== TWEET_EVIDENCE_PROTOCOL
    || audit.request_nonce !== protocol.nonce
    || audit.request_timestamp !== protocol.requestTimestamp
    || typeof audit.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(audit.body_sha256)
    || typeof audit.response_hmac !== 'string' || !/^[a-f0-9]{64}$/.test(audit.response_hmac)) {
    throw new Error('unsafe_tweet_audit:protocol');
  }
  if (await sha256Hex(bodyText) !== audit.body_sha256) throw new Error('unsafe_tweet_audit:body_digest');
  const typed = audit as unknown as TweetEvidenceAudit;
  // 与文档路径同款:对整个 keyring 逐个试,记录命中的 key id(支持密钥轮换期的历史 key)。
  for (const [keyId, secret] of responseKeys.keys) {
    if (await verifyTweetEvidenceAuditResponseHmac(typed, secret)) return { audit: typed, responseKeyId: keyId };
  }
  throw new Error('unsafe_tweet_audit:signature');
}

function tweetString(value: unknown, max: number): string {
  return typeof value === 'string' && value.length <= max ? value : '';
}

/**
 * 推文取证客户端。与 fetchPublicDocument 并列,但走 /v1/tweet 与独立 audit。
 * 网关错误按契约第 4 节以 `tweet_evidence:<code>` 抛出,transient/终态由
 * TWEET_EVIDENCE_ERROR_SEMANTICS 决定(见 manual-news-leads-pipeline 的分类)。
 */
export async function fetchTweetEvidence(
  input: string,
  deps: { service?: TrustedResearchService; timeoutMs?: number } = {},
): Promise<TweetEvidence> {
  const status = parseTwitterStatusUrl(input);
  if (!status) throw new Error('tweet_evidence:invalid_tweet_url');
  const target = validatePublicHttpUrl(input);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = trustedEndpoint(deps.service, '/v1/tweet');
  const responseKeys = parseManualNewsKeyring({
    keyId: deps.service?.responseKeyId,
    secret: deps.service?.responseSecret,
    keyringJson: deps.service?.responseKeyringJson,
  }, 'trusted_research_response_keys_unavailable');
  const protocolNow = deps.service?.protocolNow || Date.now;
  const requestNow = protocolNow();
  if (!Number.isFinite(requestNow)) throw new Error('invalid_trusted_research_clock');
  const requestNonce = (deps.service?.nonceFactory || randomRequestNonce)();
  if (!validRequestNonce(requestNonce)) throw new Error('invalid_trusted_research_nonce');
  const requestTimestamp = new Date(requestNow).toISOString();

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const init: RequestInit = {
    method: 'POST', redirect: 'manual', signal: controller.signal,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ai-feeds-manual-news-lead/2.0',
    },
    // 请求体形状严格:网关对多一个键/少一个键都返回 400 invalid_request。
    body: JSON.stringify({
      url: target.toString(),
      request_nonce: requestNonce,
      request_timestamp: requestTimestamp,
    }),
  };
  const pending = endpoint.fetcher ? endpoint.fetcher(endpoint.url, init) : fetch(endpoint.url, init);
  const response = await withinDeadline(pending, deadline, controller);
  try {
    if (!response.ok) {
      // 网关把契约里的错误码放在 JSON body 的 error 字段。读出来才能做 transient/终态分级,
      // 笼统抛 trusted_gateway_http_5xx 会让 tweet_provider_auth 这类配置问题被重试三次。
      let code = '';
      try {
        const failure = await withinDeadline(response.json<{ error?: unknown }>(), deadline, controller);
        if (typeof failure?.error === 'string') code = failure.error;
      } catch { /* 网关没给结构化 body,退回 HTTP 状态码 */ }
      throw new Error(code
        ? `tweet_evidence:${code}`
        : `tweet_evidence:gateway_http_${response.status}`);
    }
    const transportType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (transportType !== 'application/json') throw new Error('invalid_gateway_content_type');
    const bodyText = await withinDeadline(response.text(), deadline, controller);
    if (bodyText.length > TWEET_EVIDENCE_MAX_BYTES) throw new Error('response_too_large');
    const { audit, responseKeyId } = await parseTweetEvidenceAudit(
      response, target, bodyText,
      { nonce: requestNonce, requestTimestamp, now: protocolNow() },
      responseKeys,
    );
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(bodyText) as Record<string, unknown>; }
    catch { throw new Error('invalid_gateway_json'); }

    const text = tweetString(payload.text, 64_000);
    if (!text.trim()) throw new Error('tweet_evidence:tweet_empty');
    if (tweetString(payload.tweet_id, 25) !== audit.tweet_id
      || tweetString(payload.canonical_url, 512) !== audit.canonical_url) {
      throw new Error('unsafe_tweet_audit:body_mismatch');
    }
    const publishedAtRaw = tweetString(payload.published_at, 128);
    const publishedAtMs = publishedAtRaw ? Date.parse(publishedAtRaw) : NaN;
    const images = Array.isArray(payload.images)
      ? payload.images.filter((item): item is string => typeof item === 'string' && item.length <= 2_048).slice(0, 64)
      : [];
    const metrics: Record<string, number> = {};
    if (payload.metrics && typeof payload.metrics === 'object' && !Array.isArray(payload.metrics)) {
      for (const [key, value] of Object.entries(payload.metrics as Record<string, unknown>)) {
        if (/^[a-z_]{1,32}$/.test(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          metrics[key] = value;
        }
      }
    }
    return {
      tweet_id: audit.tweet_id,
      canonical_url: audit.canonical_url,
      author: tweetString(payload.author, 256),
      author_handle: tweetString(payload.author_handle, 64),
      published_at: Number.isFinite(publishedAtMs) ? new Date(publishedAtMs).toISOString() : null,
      published_at_raw: publishedAtRaw,
      language: tweetString(payload.language, 32),
      text,
      images,
      metrics,
      fetch_audit: audit,
      response_key_id: responseKeyId,
    };
  } finally {
    controller.abort();
  }
}

/**
 * 契约第 4 节的「云端应视为」列,逐条照搬。
 * 只有 tweet_provider_unavailable / egress_proxy_unavailable 值得重试;
 * tweet_provider_auth(502)与 tweet_provider_not_configured(503)虽然是 5xx,
 * 但是不会自愈的凭证/配置问题,必须从通用 5xx transient 规则里摘出来当终态。
 */
export const TWEET_EVIDENCE_ERROR_SEMANTICS: Readonly<Record<string, { transient: boolean; message: string }>> = {
  invalid_request: { transient: false, message: '推文取证请求被网关判为格式不合法（云端与网关契约不一致，需排查版本）。' },
  invalid_tweet_url: { transient: false, message: '这条链接不是可识别的 X/Twitter 推文链接，请提供形如 x.com/用户名/status/编号 的地址。' },
  unauthorized: { transient: false, message: '推文取证网关拒绝了云端凭证（Bearer 不匹配），需要运维核对 token。' },
  tweet_not_found: { transient: false, message: '这条推文不存在、已删除或不可见，无法取证。' },
  method_not_allowed: { transient: false, message: '推文取证网关拒绝了该请求方法（云端与网关契约不一致）。' },
  request_too_large: { transient: false, message: '推文取证请求体过大（云端与网关契约不一致）。' },
  unsupported_media_type: { transient: false, message: '推文取证请求的 Content-Type 不被网关接受（云端与网关契约不一致）。' },
  tweet_empty: { transient: false, message: '提供方返回了这条推文，但没有可用正文，无法作为证据。' },
  tweet_provider_unavailable: { transient: true, message: '推文提供方暂时不可用（5xx/超时），已自动重试。' },
  egress_proxy_unavailable: { transient: true, message: '推文取证的出站代理暂时不可用（是代理故障，不是 X 的问题），已自动重试。' },
  tweet_provider_not_configured: { transient: false, message: '推文取证网关没有配置提供方凭证（SCRAPEBADGER_API_KEY 缺失），需要运维补配置。' },
  tweet_response_signing_unavailable: { transient: false, message: '推文取证网关没有配置响应签名密钥，无法产出可校验的证据，需要运维补配置。' },
  tweet_provider_auth: { transient: false, message: '推文提供方拒绝了凭证（key 失效或额度耗尽），需要运维处理，重试无效。' },
  // 网关止血码:/v1/document 见到 X status 链接时立即返回 422。云端接上 /v1/tweet 之后
  // 不应再出现;留在这里是为了「万一走了旧路径」也能给 owner 一句人话而不是未知错误码。
  x_link_requires_tweet_api: { transient: false, message: 'X 链接需要走推文取证通道，当前请求走了网页抓取路径（云端版本落后于网关，请等待升级）。' },
};

export function tweetEvidenceErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error || '');
  const match = /^tweet_evidence:([a-z0-9_]+)$/.exec(message);
  return match ? match[1] : null;
}

export function isTransientTweetEvidenceError(error: unknown): boolean | null {
  const code = tweetEvidenceErrorCode(error);
  if (!code) return null;
  return TWEET_EVIDENCE_ERROR_SEMANTICS[code]?.transient ?? false;
}

export function tweetEvidencePublicMessage(error: unknown): string | null {
  const code = tweetEvidenceErrorCode(error);
  if (!code) return null;
  return TWEET_EVIDENCE_ERROR_SEMANTICS[code]?.message
    ?? '推文取证网关返回了未知错误码，请联系运维查看网关日志。';
}


const PROOF_EXCERPT_WHITESPACE =
  /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu;

export function deriveManualNewsProofExcerpt(value: string): string {
  const normalized = value.normalize('NFC')
    .replace(PROOF_EXCERPT_WHITESPACE, ' ')
    .replace(/^ +| +$/gu, '');
  return Array.from(normalized).slice(0, PROOF_EXCERPT_MAX_CODE_POINTS).join('').replace(/ +$/gu, '');
}

function unsafe(reason: string): Error { return new Error(`unsafe_url:${reason}`); }

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function parseIpv6(value: string): number[] | null {
  let host = normalizedHostname(value);
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) {
    const ipv4 = parseIpv4(dotted[2]);
    if (!ipv4) return null;
    host = `${dotted[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/i.test(host) || (host.match(/::/g) || []).length > 1) return null;
  const [leftPart, rightPart = ''] = host.split('::');
  const left = leftPart ? leftPart.split(':') : [];
  const right = rightPart ? rightPart.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const omitted = 8 - left.length - right.length;
  if ((host.includes('::') && omitted < 1) || (!host.includes('::') && omitted !== 0)) return null;
  return [...left, ...Array(Math.max(0, omitted)).fill('0'), ...right].map((part) => parseInt(part, 16));
}

interface SpecialIpv4Range { cidr: string; reason: string; }

// IANA IPv4 Special-Purpose Address Registry ranges. Treat the whole registry
// as non-targetable: even globally routed anycast/protocol assignments are not
// ordinary origin peers and must fail closed at this research boundary.
const SPECIAL_IPV4_RANGES: readonly SpecialIpv4Range[] = [
  { cidr: '0.0.0.0/8', reason: 'this-network' },
  { cidr: '10.0.0.0/8', reason: 'private-use' },
  { cidr: '100.64.0.0/10', reason: 'shared-address-space' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.0.0/16', reason: 'link-local' },
  { cidr: '172.16.0.0/12', reason: 'private-use' },
  { cidr: '192.0.0.0/24', reason: 'ietf-protocol-assignments' },
  { cidr: '192.0.2.0/24', reason: 'documentation' },
  { cidr: '192.31.196.0/24', reason: 'as112-v4' },
  { cidr: '192.52.193.0/24', reason: 'amt' },
  { cidr: '192.88.99.0/24', reason: 'deprecated-6to4-relay' },
  { cidr: '192.168.0.0/16', reason: 'private-use' },
  { cidr: '192.175.48.0/24', reason: 'as112-direct-delegation' },
  { cidr: '198.18.0.0/15', reason: 'benchmarking' },
  { cidr: '198.51.100.0/24', reason: 'documentation' },
  { cidr: '203.0.113.0/24', reason: 'documentation' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  { cidr: '240.0.0.0/4', reason: 'reserved' },
] as const;

function ipv4Number(octets: readonly number[]): number {
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

const COMPILED_SPECIAL_IPV4_RANGES = SPECIAL_IPV4_RANGES.map((range) => {
  const [address, prefixText] = range.cidr.split('/');
  const octets = parseIpv4(address)!;
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { ...range, network: ipv4Number(octets) & mask, mask };
});

function isGlobalUnicastIpv4(octets: readonly number[]): boolean {
  const address = ipv4Number(octets);
  return !COMPILED_SPECIAL_IPV4_RANGES.some((range) => (address & range.mask) === range.network);
}

function ipv6Bytes(words: readonly number[]): number[] {
  return words.flatMap((word) => [word >>> 8, word & 0xff]);
}

function bytesMatchPrefix(bytes: readonly number[], prefix: readonly number[], prefixBits: number): boolean {
  const fullBytes = Math.floor(prefixBits / 8);
  for (let index = 0; index < fullBytes; index++) if (bytes[index] !== prefix[index]) return false;
  const remaining = prefixBits % 8;
  if (!remaining) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function embeddedIpv4IsGlobal(bytes: readonly number[]): boolean {
  return bytes.length === 4 && isGlobalUnicastIpv4(bytes);
}

export function isPublicIpAddress(value: string): boolean {
  const host = normalizedHostname(value);
  const ipv4 = parseIpv4(host);
  if (ipv4) return isGlobalUnicastIpv4(ipv4);
  if (!host.includes(':')) return false;
  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  const bytes = ipv6Bytes(ipv6);

  // IPv4-compatible and IPv4-mapped forms.
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return embeddedIpv4IsGlobal(bytes.slice(12));
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedIpv4IsGlobal(bytes.slice(12));
  }
  // RFC 6052 well-known NAT64 /96.
  if (bytesMatchPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return embeddedIpv4IsGlobal(bytes.slice(12));
  }
  // RFC 8215 local-use NAT64 /48. For a /48 prefix, the IPv4 bits occupy
  // bytes 6,7,9,10 and byte 8 is the required zero u-octet (RFC 6052).
  if (bytesMatchPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) {
    return bytes[8] === 0 && embeddedIpv4IsGlobal([bytes[6], bytes[7], bytes[9], bytes[10]]);
  }
  // 6to4 carries the origin IPv4 directly after 2002::/16.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embeddedIpv4IsGlobal(bytes.slice(2, 6));
  // Teredo carries a server IPv4 and an obfuscated client IPv4. Both peers must
  // be global unicast; accepting only one would permit a private rebinding path.
  if (bytesMatchPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) {
    const client = bytes.slice(12, 16).map((byte) => byte ^ 0xff);
    return embeddedIpv4IsGlobal(bytes.slice(4, 8)) && embeddedIpv4IsGlobal(client);
  }

  // Current ordinary IPv6 global unicast is 2000::/3. Reject future/reserved
  // address space until IANA explicitly makes it targetable.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  const specialIpv6Prefixes: Array<{ bytes: number[]; bits: number }> = [
    { bytes: [0x20, 0x01, 0x00, 0x00], bits: 23 }, // IETF protocol assignments
    { bytes: [0x20, 0x01, 0x0d, 0xb8], bits: 32 }, // documentation
    { bytes: [0x26, 0x20, 0x00, 0x4f, 0x80, 0x00], bits: 48 }, // AS112
    { bytes: [0x3f, 0xff, 0x00], bits: 20 }, // documentation
  ];
  return !specialIpv6Prefixes.some((range) => bytesMatchPrefix(bytes, range.bytes, range.bits));
}

function canonicalIpAddress(value: string): string | null {
  const host = normalizedHostname(value);
  const ipv4 = parseIpv4(host);
  if (ipv4) return ipv4.join('.');
  const ipv6 = parseIpv6(host);
  return ipv6 ? ipv6.map((word) => word.toString(16).padStart(4, '0')).join(':') : null;
}

export function validatePublicHttpUrl(input: string): URL {
  let url: URL;
  try { url = new URL(String(input || '').trim()); } catch { throw unsafe('invalid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unsafe('protocol');
  if (url.username || url.password) throw unsafe('credentials');
  if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) {
    throw unsafe('port');
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw unsafe('host');
  if ((parseIpv4(hostname) || hostname.includes(':')) && !isPublicIpAddress(hostname)) throw unsafe('literal_address');
  url.hostname = url.hostname.replace(/\.+$/, '');
  return url;
}

export function normalizeWeChatArticleUrl(input: string): string {
  let url: URL;
  try { url = new URL(String(input || '').trim()); } catch { throw new Error('unsafe_gateway_provider:input_url'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com'
    || url.username || url.password || url.port) {
    throw new Error('unsafe_gateway_provider:input_url');
  }
  if (/^\/s\/[A-Za-z0-9_-]{10,256}$/.test(url.pathname)) {
    if (url.search) throw new Error('unsafe_gateway_provider:input_url');
    return `https://mp.weixin.qq.com${url.pathname}`;
  }
  if (url.pathname !== '/s') throw new Error('unsafe_gateway_provider:input_url');
  const entries = [...url.searchParams.entries()];
  const expectedKeys = ['__biz', 'mid', 'idx', 'sn'];
  if (entries.length !== expectedKeys.length
    || expectedKeys.some((key) => entries.filter(([candidate]) => candidate === key).length !== 1)
    || entries.some(([key]) => !expectedKeys.includes(key))) {
    throw new Error('unsafe_gateway_provider:input_url');
  }
  const biz = url.searchParams.get('__biz') || '';
  const mid = url.searchParams.get('mid') || '';
  const idx = url.searchParams.get('idx') || '';
  const sn = url.searchParams.get('sn') || '';
  if (!/^[A-Za-z0-9_+/-]{4,256}={0,2}$/.test(biz)
    || !/^\d{1,32}$/.test(mid) || !/^\d{1,4}$/.test(idx) || !/^[a-fA-F0-9]{16,128}$/.test(sn)) {
    throw new Error('unsafe_gateway_provider:input_url');
  }
  return `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz).replace(/%3D/gi, '=')}`
    + `&mid=${mid}&idx=${idx}&sn=${sn.toLowerCase()}`;
}

function trustedEndpoint(service: TrustedResearchService | undefined, path: '/v1/document' | '/v1/search' | '/v1/tweet') {
  if (!service) throw new Error('trusted_research_service_required');
  let origin: URL;
  try { origin = validatePublicHttpUrl(service.origin); } catch { throw new Error('invalid_trusted_research_origin'); }
  if (
    origin.protocol !== 'https:' || origin.username || origin.password || origin.port ||
    (origin.pathname !== '/' && origin.pathname !== '') || origin.search || origin.hash
  ) throw new Error('invalid_trusted_research_origin');
  if (!service.token || service.token.length > 512) throw new Error('invalid_trusted_research_token');
  return {
    url: new URL(path, origin), fetcher: service.fetcher, token: service.token,
    responseSecret: service.responseSecret,
    protocolNow: service.protocolNow,
    nonceFactory: service.nonceFactory,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function canonicalIsoTimestamp(value: unknown): { value: string; timestamp: number } | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized === value ? { value: normalized, timestamp } : null;
}

function randomRequestNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validRequestNonce(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{32,128}|[A-Za-z0-9_-]{22,171})$/.test(value);
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left[index] || 0) ^ (right[index] || 0);
  return mismatch === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyResponseHmac(
  secret: string,
  unsigned: Record<string, unknown>,
  supplied: string,
  domain = '',
): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', hexBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${domain}${canonicalJson(unsigned)}`),
  ));
  return constantTimeBytesEqual(signature, hexBytes(supplied));
}

export async function verifyDocumentFetchAuditResponseHmac(
  audit: DocumentFetchAudit,
  responseSecret: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(responseSecret)
    || !/^[a-f0-9]{64}$/.test(audit.response_hmac || '')) return false;
  const { response_hmac: suppliedHmac, ...unsignedAudit } = audit;
  return verifyResponseHmac(responseSecret, unsignedAudit, suppliedHmac!);
}

export async function verifyProviderRetrievalAuditResponseHmac(
  audit: ProviderRetrievalAudit,
  responseSecret: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(responseSecret)
    || !/^[a-f0-9]{64}$/.test(audit.response_hmac || '')) return false;
  const { response_hmac: suppliedHmac, ...unsignedAudit } = audit;
  return verifyResponseHmac(responseSecret, unsignedAudit, suppliedHmac, PROVIDER_HMAC_DOMAIN);
}

function strictObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseLimits(value: unknown, error: string, allowZero: boolean): DocumentExtractionLimits {
  if (!strictObject(value, ['source_bytes', 'extracted_text_bytes', 'extracted_text_characters'])) {
    throw new Error(error);
  }
  const entries = [value.source_bytes, value.extracted_text_bytes, value.extracted_text_characters];
  if (entries.some((entry) => !Number.isSafeInteger(entry) || (allowZero ? Number(entry) < 0 : Number(entry) <= 0))) {
    throw new Error(error);
  }
  return {
    source_bytes: value.source_bytes as number,
    extracted_text_bytes: value.extracted_text_bytes as number,
    extracted_text_characters: value.extracted_text_characters as number,
  };
}

function sameLimits(left: DocumentExtractionLimits, right: DocumentExtractionLimits): boolean {
  return left.source_bytes === right.source_bytes
    && left.extracted_text_bytes === right.extracted_text_bytes
    && left.extracted_text_characters === right.extracted_text_characters;
}

function canonicalProviderPublishedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  return value;
}

function providerOperationIdentity(
  inputUrl: string,
  retrievalOperationId?: string,
  retrievalGeneration?: number,
) {
  return {
    extraction_mode: ARTICLE_TEXT_PROTOCOL_V2,
    normalized_url: inputUrl,
    response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
    ...(retrievalOperationId === undefined ? {} : {
      retrieval_operation_id: retrievalOperationId,
      retrieval_generation: retrievalGeneration,
    }),
  };
}

export async function deriveRedFoxProviderOperationId(
  inputUrl: string,
  retrievalOperationId?: string,
  retrievalGeneration?: number,
): Promise<string> {
  return sha256Hex(`${REDFOX_OPERATION_DOMAIN}${canonicalJson(providerOperationIdentity(
    inputUrl, retrievalOperationId, retrievalGeneration,
  ))}`);
}

export async function deriveManualNewsRetrievalOperationId(
  inputUrl: string,
): Promise<string | null> {
  let normalizedUrl: string;
  try { normalizedUrl = normalizeWeChatArticleUrl(inputUrl); }
  catch { return null; }
  return sha256Hex(`${MANUAL_NEWS_RETRIEVAL_OPERATION_DOMAIN}${canonicalJson({
    extraction_mode: ARTICLE_TEXT_PROTOCOL_V2,
    normalized_url: normalizedUrl,
    response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
  })}`);
}

function parseProviderIdentityAssertion(
  value: unknown,
  inputUrl: string,
  canonicalOriginalUrl: string,
  publisher: string,
): ProviderRetrievalAudit['identity_assertion'] {
  const keys = [
    'contract', 'requested_url', 'requested_short_url', 'provider_asserted_source_url',
    'provider_asserted_canonical_url', 'provider_asserted_publisher', 'provider_asserted_wechat_biz',
    'assurance',
  ];
  const canonical = new URL(canonicalOriginalUrl);
  const expectedShortUrl = new URL(inputUrl).pathname === '/s' ? null : inputUrl;
  const expectedBiz = canonical.searchParams.get('__biz') || '';
  if (!strictObject(value, keys)
    || value.contract !== REDFOX_IDENTITY_ASSERTION_CONTRACT
    || value.requested_url !== inputUrl
    || value.requested_short_url !== expectedShortUrl
    || value.provider_asserted_source_url !== canonicalOriginalUrl
    || value.provider_asserted_canonical_url !== canonicalOriginalUrl
    || value.provider_asserted_publisher !== publisher
    || value.provider_asserted_wechat_biz !== expectedBiz
    || value.assurance !== REDFOX_IDENTITY_ASSERTION_ASSURANCE
    || !expectedBiz) {
    throw new Error('unsafe_gateway_provider:identity_assertion');
  }
  const frozen = FROZEN_REDFOX_SHORT_ASSERTIONS.get(inputUrl);
  if (frozen && (frozen.canonical_url !== canonicalOriginalUrl
    || frozen.publisher !== publisher || frozen.wechat_biz !== expectedBiz)) {
    throw new Error('unsafe_gateway_provider:identity_assertion');
  }
  return value as ProviderRetrievalAudit['identity_assertion'];
}

function parseProviderRetrievalAudit(
  raw: Record<string, unknown>,
  requested: URL,
  protocol: {
    nonce: string;
    requestTimestamp: string;
    now: number;
    retrievalOperationId?: string;
    retrievalGeneration?: number;
  },
): ProviderRetrievalAudit {
  const baseAuditKeys = [
    'retrieval_type', 'provider_id', 'operation_id', 'input_url', 'canonical_original_url',
    'identity_assertion', 'title', 'publisher', 'published_at', 'provider_retrieved_at',
    'cache_status', 'limits', 'actual_sizes',
    'protocol_version', 'request_nonce', 'request_timestamp', 'response_created_at', 'body_sha256',
    'response_profile', 'response_hmac_contract', 'proof_excerpt', 'response_hmac',
  ];
  const generatedOperation = protocol.retrievalOperationId !== undefined;
  const auditKeys = generatedOperation
    ? [...baseAuditKeys, 'retrieval_operation_id', 'retrieval_generation']
    : baseAuditKeys;
  if (!strictObject(raw, auditKeys)
    || raw.retrieval_type !== 'provider'
    || raw.provider_id !== REDFOX_PROVIDER_ID
    || raw.protocol_version !== PROVIDER_RETRIEVAL_PROTOCOL
    || raw.request_nonce !== protocol.nonce
    || raw.request_timestamp !== protocol.requestTimestamp
    || raw.response_profile !== PROOF_EXCERPT_RESPONSE_PROFILE
    || raw.response_hmac_contract !== PROVIDER_RESPONSE_HMAC_CONTRACT
    || (generatedOperation && (raw.retrieval_operation_id !== protocol.retrievalOperationId
      || raw.retrieval_generation !== protocol.retrievalGeneration))
    || typeof raw.operation_id !== 'string' || !/^[a-f0-9]{64}$/.test(raw.operation_id)
    || !['miss', 'hit', 'coalesced', 'durable'].includes(String(raw.cache_status))) {
    throw new Error('unsafe_gateway_provider:invalid_schema');
  }
  let expectedInputUrl: string;
  let inputUrl: string;
  let canonicalOriginalUrl: string;
  try {
    expectedInputUrl = normalizeWeChatArticleUrl(requested.toString());
    inputUrl = normalizeWeChatArticleUrl(String(raw.input_url));
    canonicalOriginalUrl = normalizeWeChatArticleUrl(String(raw.canonical_original_url));
  } catch {
    throw new Error('unsafe_gateway_provider:url');
  }
  if (inputUrl !== raw.input_url || inputUrl !== expectedInputUrl
    || canonicalOriginalUrl !== raw.canonical_original_url
    || new URL(canonicalOriginalUrl).pathname !== '/s'
    || (new URL(expectedInputUrl).pathname === '/s' && canonicalOriginalUrl !== expectedInputUrl)) {
    throw new Error('unsafe_gateway_provider:url');
  }
  if (typeof raw.title !== 'string' || !raw.title || raw.title !== raw.title.trim()
    || raw.title.normalize('NFC') !== raw.title || Array.from(raw.title).length > 220
    || new TextEncoder().encode(raw.title).byteLength > 1_024
    || typeof raw.publisher !== 'string' || !raw.publisher || raw.publisher !== raw.publisher.trim()
    || raw.publisher.normalize('NFC') !== raw.publisher || Array.from(raw.publisher).length > 120
    || new TextEncoder().encode(raw.publisher).byteLength > 512
    || canonicalProviderPublishedAt(raw.published_at) === null) {
    throw new Error('unsafe_gateway_provider:metadata');
  }
  const identityAssertion = parseProviderIdentityAssertion(
    raw.identity_assertion,
    inputUrl,
    canonicalOriginalUrl,
    raw.publisher,
  );
  const requestTimestamp = canonicalIsoTimestamp(raw.request_timestamp);
  const responseCreatedAt = canonicalIsoTimestamp(raw.response_created_at);
  const providerRetrievedAt = canonicalIsoTimestamp(raw.provider_retrieved_at);
  if (!requestTimestamp || !responseCreatedAt || !providerRetrievedAt
    || responseCreatedAt.timestamp < requestTimestamp.timestamp - ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || responseCreatedAt.timestamp > protocol.now + ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || protocol.now - responseCreatedAt.timestamp > ARTICLE_TEXT_V2_MAX_SKEW_MS
    || providerRetrievedAt.timestamp > responseCreatedAt.timestamp + ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || (raw.cache_status !== 'durable'
      && requestTimestamp.timestamp - providerRetrievedAt.timestamp > ARTICLE_TEXT_V2_MAX_SKEW_MS)) {
    throw new Error('unsafe_gateway_provider:timestamp');
  }
  const limitKeys = ['provider_response_bytes', 'extracted_text_bytes', 'extracted_text_characters', 'image_count'];
  if (!strictObject(raw.limits, limitKeys) || !strictObject(raw.actual_sizes, limitKeys)
    || raw.limits.provider_response_bytes !== PROVIDER_RESPONSE_MAX_BYTES
    || raw.limits.extracted_text_bytes !== ARTICLE_TEXT_MAX_BYTES
    || raw.limits.extracted_text_characters !== ARTICLE_TEXT_MAX_CHARACTERS
    || raw.limits.image_count !== PROVIDER_IMAGE_MAX_COUNT) {
    throw new Error('unsafe_gateway_provider:limits');
  }
  const limits = raw.limits as Record<string, unknown>;
  const actualSizes = raw.actual_sizes;
  if (limitKeys.some((key) => !Number.isSafeInteger(actualSizes[key]) || Number(actualSizes[key]) < 0
    || Number(actualSizes[key]) > Number(limits[key]))
    || Number(actualSizes.provider_response_bytes) < 1) {
    throw new Error('unsafe_gateway_provider:sizes');
  }
  if (typeof raw.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.body_sha256)
    || typeof raw.response_hmac !== 'string' || !/^[a-f0-9]{64}$/.test(raw.response_hmac)
    || !strictObject(raw.proof_excerpt, [
      'contract', 'algorithm', 'max_code_points', 'sha256', 'utf8_bytes', 'code_points',
    ])
    || raw.proof_excerpt.contract !== PROOF_EXCERPT_CONTRACT
    || raw.proof_excerpt.algorithm !== PROOF_EXCERPT_ALGORITHM
    || raw.proof_excerpt.max_code_points !== PROOF_EXCERPT_MAX_CODE_POINTS
    || typeof raw.proof_excerpt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.proof_excerpt.sha256)
    || !Number.isSafeInteger(raw.proof_excerpt.utf8_bytes)
    || Number(raw.proof_excerpt.utf8_bytes) < 0
    || Number(raw.proof_excerpt.utf8_bytes) > PROOF_EXCERPT_MAX_UTF8_BYTES
    || !Number.isSafeInteger(raw.proof_excerpt.code_points)
    || Number(raw.proof_excerpt.code_points) < 0
    || Number(raw.proof_excerpt.code_points) > PROOF_EXCERPT_MAX_CODE_POINTS) {
    throw new Error('unsafe_gateway_provider:proof');
  }
  return {
    retrieval_type: 'provider',
    provider_id: REDFOX_PROVIDER_ID,
    operation_id: raw.operation_id,
    ...(generatedOperation ? {
      retrieval_operation_id: raw.retrieval_operation_id as string,
      retrieval_generation: raw.retrieval_generation as number,
    } : {}),
    input_url: inputUrl,
    canonical_original_url: canonicalOriginalUrl,
    identity_assertion: identityAssertion,
    title: raw.title,
    publisher: raw.publisher,
    published_at: raw.published_at as string,
    provider_retrieved_at: providerRetrievedAt.value,
    cache_status: raw.cache_status as ProviderRetrievalAudit['cache_status'],
    limits: {
      provider_response_bytes: PROVIDER_RESPONSE_MAX_BYTES,
      extracted_text_bytes: ARTICLE_TEXT_MAX_BYTES,
      extracted_text_characters: ARTICLE_TEXT_MAX_CHARACTERS,
      image_count: PROVIDER_IMAGE_MAX_COUNT,
    },
    actual_sizes: {
      provider_response_bytes: Number(actualSizes.provider_response_bytes),
      extracted_text_bytes: Number(actualSizes.extracted_text_bytes),
      extracted_text_characters: Number(actualSizes.extracted_text_characters),
      image_count: Number(actualSizes.image_count),
    },
    protocol_version: PROVIDER_RETRIEVAL_PROTOCOL,
    request_nonce: raw.request_nonce as string,
    request_timestamp: requestTimestamp.value,
    response_created_at: responseCreatedAt.value,
    body_sha256: raw.body_sha256,
    response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
    response_hmac_contract: PROVIDER_RESPONSE_HMAC_CONTRACT,
    proof_excerpt: {
      contract: PROOF_EXCERPT_CONTRACT,
      algorithm: PROOF_EXCERPT_ALGORITHM,
      max_code_points: PROOF_EXCERPT_MAX_CODE_POINTS,
      sha256: raw.proof_excerpt.sha256,
      utf8_bytes: Number(raw.proof_excerpt.utf8_bytes),
      code_points: Number(raw.proof_excerpt.code_points),
    },
    response_hmac: raw.response_hmac,
  };
}

function parseFetchAudit(
  response: Response,
  requested: URL,
  maxRedirects: number,
  expectedLimits: DocumentExtractionLimits,
  protocol: { nonce: string; requestTimestamp: string; now: number },
): ManualNewsFetchAudit {
  const encoded = response.headers.get('X-AIFeeds-Fetch-Audit') || '';
  if (!encoded || encoded.length > 8_192) throw new Error('unsafe_gateway_audit:missing');
  let raw: unknown;
  try { raw = JSON.parse(decodeURIComponent(encoded)); } catch { throw new Error('unsafe_gateway_audit:invalid_json'); }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as Record<string, unknown>).protocol_version === PROVIDER_RETRIEVAL_PROTOCOL) {
    return parseProviderRetrievalAudit(raw as Record<string, unknown>, requested, protocol);
  }
  const auditKeys = [
    'hops', 'source_content_type', 'extraction', 'requested_limits', 'applied_limits',
    'actual_sizes', 'truncation', 'parser', 'protocol_version', 'request_nonce',
    'request_timestamp', 'extracted_at', 'final_url', 'body_sha256', 'response_profile',
    'response_hmac_contract', 'proof_excerpt', 'response_hmac',
  ];
  if ((raw as { extraction?: unknown })?.extraction === 'article_text') auditKeys.push('document');
  if (!strictObject(raw, auditKeys) || !Array.isArray(raw.hops)) {
    throw new Error('unsafe_gateway_audit:invalid_schema');
  }
  if (raw.hops.length < 1) throw new Error('unsafe_gateway_audit:missing_hop');
  if (raw.hops.length - 1 > maxRedirects) throw new Error('too_many_redirects');
  const hops: FetchAuditHop[] = [];
  for (const value of raw.hops) {
    if (!strictObject(value, ['url', 'validated_ip', 'connected_ip'])
      || typeof value.url !== 'string' || typeof value.validated_ip !== 'string' || typeof value.connected_ip !== 'string') {
      throw new Error('unsafe_gateway_audit:invalid_hop');
    }
    const url = validatePublicHttpUrl(value.url).toString();
    const validated = canonicalIpAddress(value.validated_ip);
    const connected = canonicalIpAddress(value.connected_ip);
    if (!validated || !connected || !isPublicIpAddress(validated) || !isPublicIpAddress(connected) || validated !== connected) {
      throw new Error('unsafe_gateway_audit:peer_mismatch');
    }
    hops.push({ url, validated_ip: validated, connected_ip: connected });
  }
  if (hops[0].url !== requested.toString()) throw new Error('unsafe_gateway_audit:request_mismatch');
  const requestTimestamp = canonicalIsoTimestamp(raw.request_timestamp);
  const extractedAt = canonicalIsoTimestamp(raw.extracted_at);
  if (raw.protocol_version !== ARTICLE_TEXT_PROTOCOL_V2
    || raw.request_nonce !== protocol.nonce
    || raw.request_timestamp !== protocol.requestTimestamp
    || !requestTimestamp || !extractedAt
    || extractedAt.timestamp < requestTimestamp.timestamp - ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || extractedAt.timestamp > protocol.now + ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || protocol.now - extractedAt.timestamp > ARTICLE_TEXT_V2_MAX_SKEW_MS
    || typeof raw.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.body_sha256)
    || typeof raw.response_hmac !== 'string' || !/^[a-f0-9]{64}$/.test(raw.response_hmac)) {
    throw new Error('unsafe_gateway_audit:protocol');
  }
  if (raw.response_profile !== PROOF_EXCERPT_RESPONSE_PROFILE
    || raw.response_hmac_contract !== PROOF_EXCERPT_RESPONSE_HMAC_CONTRACT
    || !strictObject(raw.proof_excerpt, [
      'contract', 'algorithm', 'max_code_points', 'sha256', 'utf8_bytes', 'code_points',
    ])
    || raw.proof_excerpt.contract !== PROOF_EXCERPT_CONTRACT
    || raw.proof_excerpt.algorithm !== PROOF_EXCERPT_ALGORITHM
    || raw.proof_excerpt.max_code_points !== PROOF_EXCERPT_MAX_CODE_POINTS
    || typeof raw.proof_excerpt.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.proof_excerpt.sha256)
    || !Number.isSafeInteger(raw.proof_excerpt.utf8_bytes)
    || Number(raw.proof_excerpt.utf8_bytes) < 0
    || Number(raw.proof_excerpt.utf8_bytes) > PROOF_EXCERPT_MAX_UTF8_BYTES
    || !Number.isSafeInteger(raw.proof_excerpt.code_points)
    || Number(raw.proof_excerpt.code_points) < 0
    || Number(raw.proof_excerpt.code_points) > PROOF_EXCERPT_MAX_CODE_POINTS) {
    throw new Error('unsafe_gateway_audit:proof_excerpt');
  }
  if (typeof raw.source_content_type !== 'string' || !ALLOWED_SOURCE_TYPES.has(raw.source_content_type)) {
    throw new Error('unsafe_gateway_audit:content_type');
  }
  if (typeof raw.extraction !== 'string') throw new Error('unsafe_gateway_audit:extraction');
  if (raw.source_content_type === 'application/pdf' && raw.extraction !== 'pdf_text') {
    throw new Error('invalid_pdf_extraction');
  }
  if (!['article_text', 'text', 'json', 'pdf_text'].includes(raw.extraction)) {
    throw new Error('unsafe_gateway_audit:extraction');
  }
  const extraction = raw.extraction as DocumentFetchAudit['extraction'];
  const expectedExtraction: Record<string, DocumentFetchAudit['extraction']> = {
    'text/html': 'article_text', 'application/xhtml+xml': 'article_text', 'text/plain': 'text',
    'application/json': 'json', 'application/pdf': 'pdf_text',
  };
  if (expectedExtraction[raw.source_content_type] !== extraction) throw new Error('unsafe_gateway_audit:extraction_mismatch');
  const requestedLimits = parseLimits(raw.requested_limits, 'unsafe_gateway_audit:invalid_schema', false);
  const appliedLimits = parseLimits(raw.applied_limits, 'unsafe_gateway_audit:invalid_schema', false);
  const actualSizes = parseLimits(raw.actual_sizes, 'unsafe_gateway_audit:invalid_schema', true);
  if (!sameLimits(requestedLimits, expectedLimits)
    || appliedLimits.source_bytes > requestedLimits.source_bytes
    || appliedLimits.extracted_text_bytes > requestedLimits.extracted_text_bytes
    || appliedLimits.extracted_text_characters > requestedLimits.extracted_text_characters) {
    throw new Error('unsafe_gateway_audit:limit_mismatch');
  }
  if (actualSizes.source_bytes > appliedLimits.source_bytes
    || actualSizes.extracted_text_bytes > appliedLimits.extracted_text_bytes
    || actualSizes.extracted_text_characters > appliedLimits.extracted_text_characters) {
    throw new Error('unsafe_gateway_audit:actual_size');
  }
  if (!strictObject(raw.truncation, ['source', 'extracted_text'])
    || typeof raw.truncation.source !== 'boolean' || typeof raw.truncation.extracted_text !== 'boolean') {
    throw new Error('unsafe_gateway_audit:invalid_schema');
  }
  if (raw.truncation.source || raw.truncation.extracted_text) {
    throw new Error('unsafe_gateway_audit:truncated');
  }
  if (!strictObject(raw.parser, ['result', 'version'])
    || (raw.parser.result !== 'success' && raw.parser.result !== 'failed')
    || typeof raw.parser.version !== 'string'
    || !raw.parser.version.trim()
    || raw.parser.version.length > 120) {
    throw new Error('unsafe_gateway_audit:invalid_schema');
  }
  if (raw.parser.result !== 'success') throw new Error('unsafe_gateway_audit:parser_failed');
  let documentMetadata: DocumentFetchAudit['document'];
  if (extraction === 'article_text') {
    if (!strictObject(raw.document, ['title', 'published_at', 'selection', 'content_complete'])
      || typeof raw.document.title !== 'string' || raw.document.title !== raw.document.title.trim()
      || !raw.document.title || Array.from(raw.document.title).length > 220
      || new TextEncoder().encode(raw.document.title).byteLength > 1_024
      || !['article', 'main'].includes(String(raw.document.selection))
      || raw.document.content_complete !== true
      || !/^chromium\/\d+\.\d+\.\d+\.\d+$/.test(raw.parser.version)
      || appliedLimits.extracted_text_bytes > ARTICLE_TEXT_MAX_BYTES
      || appliedLimits.extracted_text_characters > ARTICLE_TEXT_MAX_CHARACTERS) {
      throw new Error('unsafe_gateway_audit:article_metadata');
    }
    const chromiumMajor = Number(/^chromium\/(\d+)/.exec(raw.parser.version)?.[1] || 0);
    if (chromiumMajor < ARTICLE_TEXT_V2_MIN_CHROMIUM_MAJOR) {
      throw new Error('unsafe_gateway_audit:chromium_version');
    }
    const publishedAt = normalizedPublishedAt(raw.document.published_at);
    if (publishedAt === undefined || publishedAt !== raw.document.published_at) {
      throw new Error('unsafe_gateway_audit:article_metadata');
    }
    documentMetadata = {
      title: raw.document.title,
      published_at: publishedAt,
      selection: raw.document.selection as 'article' | 'main',
      content_complete: true,
    };
  }
  let finalUrl: string;
  try { finalUrl = validatePublicHttpUrl(String(raw.final_url)).toString(); } catch {
    throw new Error('unsafe_gateway_audit:final_url');
  }
  if (finalUrl !== hops.at(-1)!.url) throw new Error('unsafe_gateway_audit:final_url');
  return {
    hops,
    source_content_type: raw.source_content_type,
    extraction,
    requested_limits: requestedLimits,
    applied_limits: appliedLimits,
    actual_sizes: actualSizes,
    truncation: { source: raw.truncation.source, extracted_text: raw.truncation.extracted_text },
    parser: { result: 'success', version: raw.parser.version },
    ...(documentMetadata ? { document: documentMetadata } : {}),
    protocol_version: ARTICLE_TEXT_PROTOCOL_V2,
    request_nonce: protocol.nonce,
    request_timestamp: protocol.requestTimestamp,
    extracted_at: extractedAt.value,
    final_url: finalUrl,
    body_sha256: raw.body_sha256,
    response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
    response_hmac_contract: PROOF_EXCERPT_RESPONSE_HMAC_CONTRACT,
    proof_excerpt: {
      contract: PROOF_EXCERPT_CONTRACT,
      algorithm: PROOF_EXCERPT_ALGORITHM,
      max_code_points: PROOF_EXCERPT_MAX_CODE_POINTS,
      sha256: raw.proof_excerpt.sha256,
      utf8_bytes: Number(raw.proof_excerpt.utf8_bytes),
      code_points: Number(raw.proof_excerpt.code_points),
    },
    response_hmac: raw.response_hmac,
  };
}

export function validateCompleteArticleText(value: string, bytes: number): void {
  const characters = Array.from(value);
  if (!characters.length) throw new Error('unsafe_gateway_article_text:empty');
  if (bytes > ARTICLE_TEXT_MAX_BYTES || characters.length > ARTICLE_TEXT_MAX_CHARACTERS) {
    throw new Error('unsafe_gateway_article_text:too_large');
  }
  let allowedIgnorables = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === '\ufeff') continue;
    if (!/\p{Default_Ignorable_Code_Point}/u.test(character)) continue;
    const previous = characters[index - 1] || '';
    const next = characters[index + 1] || '';
    const contextualJoiner = character === '\u200d'
      && ((/[\p{L}\p{M}]/u.test(previous) && /[\p{L}\p{M}]/u.test(next))
        || (/\p{Extended_Pictographic}/u.test(previous) && /\p{Extended_Pictographic}/u.test(next)));
    const contextualNonJoiner = character === '\u200c'
      && /[\p{L}\p{M}]/u.test(previous) && /[\p{L}\p{M}]/u.test(next);
    const contextualVariation = /^[\ufe00-\ufe0f]$/u.test(character)
      && /\p{Extended_Pictographic}/u.test(previous);
    if (!contextualJoiner && !contextualNonJoiner && !contextualVariation) {
      throw new Error('unsafe_gateway_article_text:unsafe_unicode');
    }
    allowedIgnorables += 1;
  }
  if (allowedIgnorables > 8 && allowedIgnorables / characters.length > 0.02) {
    throw new Error('unsafe_gateway_article_text:unsafe_unicode');
  }
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number, controller: AbortController): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    throw new Error('gateway_timeout');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('gateway_timeout'));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  deadline: number,
  controller: AbortController,
): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('Content-Length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response_too_large');
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  // Preserve a decoded U+FEFF so the frozen proof-excerpt whitespace contract,
  // signed code-point count, and body digest all see the same complete text.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await withinDeadline(reader.read(), deadline, controller);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('response_too_large');
        throw new Error('response_too_large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } catch (error) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (error instanceof TypeError) throw new Error('invalid_gateway_utf8');
    throw error;
  }
}

async function postTrusted(
  service: TrustedResearchService | undefined,
  path: '/v1/document' | '/v1/search',
  payload: unknown,
  timeoutMs: number,
): Promise<{ response: Response; deadline: number; controller: AbortController }> {
  const endpoint = trustedEndpoint(service, path);
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const init: RequestInit = {
    method: 'POST', redirect: 'manual', signal: controller.signal,
    headers: {
      Accept: path === '/v1/search' ? 'application/json' : 'text/plain',
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ai-feeds-manual-news-lead/2.0',
    },
    body: JSON.stringify(payload),
  };
  const injectedFetcher = endpoint.fetcher;
  const pending = injectedFetcher ? injectedFetcher(endpoint.url, init) : fetch(endpoint.url, init);
  const response = await withinDeadline(pending, deadline, controller);
  if (!response.ok) {
    const providerError = response.headers.get('X-AIFeeds-Provider-Error') || '';
    controller.abort();
    if (((response.status === 409 && [
      'provider_billing_indeterminate',
      'provider_operation_identity_mismatch',
      'provider_billing_retry_exhausted',
    ].includes(providerError))
      || (response.status === 422 && providerError === 'provider_identity_rejected'))) {
      throw new Error(providerError);
    }
    throw new Error(`trusted_gateway_http_${response.status}`);
  }
  return { response, deadline, controller };
}

/**
 * Security invariant: this Worker never issues fetch() to a user-controlled host.
 * The only network peer is an exact configured HTTPS research-service origin. That
 * service must pin DNS validation to the connected peer on every hop and returns
 * a hop audit; this function rejects any private or mismatched validated/connected
 * address before consuming the body.
 */
export async function fetchPublicDocument(
  input: string,
  deps: {
    service?: TrustedResearchService;
    timeoutMs?: number;
    maxBytes?: number;
    maxSourceBytes?: number;
    maxTextCharacters?: number;
    maxRedirects?: number;
    retrievalOperationId?: string;
    retrievalGeneration?: number;
  } = {},
): Promise<PublicDocument> {
  const target = validatePublicHttpUrl(input);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxSourceBytes = deps.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxTextCharacters = deps.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // Preserve the base trusted-origin dependency/error contract before applying
  // the v2-only response-authentication dependency.
  trustedEndpoint(deps.service, '/v1/document');
  const responseKeys = parseManualNewsKeyring({
    keyId: deps.service?.responseKeyId,
    secret: deps.service?.responseSecret,
    keyringJson: deps.service?.responseKeyringJson,
  }, 'trusted_research_response_keys_unavailable');
  const protocolNow = deps.service?.protocolNow || Date.now;
  const requestNow = protocolNow();
  if (!Number.isFinite(requestNow)) throw new Error('invalid_trusted_research_clock');
  const requestNonce = (deps.service?.nonceFactory || randomRequestNonce)();
  if (!validRequestNonce(requestNonce)) throw new Error('invalid_trusted_research_nonce');
  const requestTimestamp = new Date(requestNow).toISOString();
  const hasRetrievalOperation = deps.retrievalOperationId !== undefined
    || deps.retrievalGeneration !== undefined;
  let retrievalFields: { retrieval_operation_id: string; retrieval_generation: number } | undefined;
  if (hasRetrievalOperation) {
    let normalizedWeChatUrl: string;
    try { normalizedWeChatUrl = normalizeWeChatArticleUrl(target.toString()); }
    catch { throw new Error('invalid_provider_retrieval_operation'); }
    if (normalizedWeChatUrl !== target.toString()
      || typeof deps.retrievalOperationId !== 'string'
      || !/^[a-f0-9]{64}$/.test(deps.retrievalOperationId)
      || !Number.isSafeInteger(deps.retrievalGeneration)
      || Number(deps.retrievalGeneration) < 0) {
      throw new Error('invalid_provider_retrieval_operation');
    }
    retrievalFields = {
      retrieval_operation_id: deps.retrievalOperationId,
      retrieval_generation: Number(deps.retrievalGeneration),
    };
  }
  const requestedLimits: DocumentExtractionLimits = {
    source_bytes: maxSourceBytes,
    extracted_text_bytes: maxBytes,
    extracted_text_characters: maxTextCharacters,
  };
  if (Object.values(requestedLimits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('invalid_document_limits');
  }
  const { response, deadline, controller } = await postTrusted(
    deps.service, '/v1/document', {
      url: target.toString(), limits: requestedLimits, max_redirects: maxRedirects,
      extraction_mode: ARTICLE_TEXT_PROTOCOL_V2,
      response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
      request_nonce: requestNonce,
      request_timestamp: requestTimestamp,
      ...(retrievalFields || {}),
    }, timeoutMs,
  );
  try {
    const transportType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (transportType !== 'text/plain') throw new Error('invalid_gateway_content_type');
    const audit = parseFetchAudit(response, target, maxRedirects, requestedLimits, {
      nonce: requestNonce,
      requestTimestamp,
      now: protocolNow(),
      ...(retrievalFields ? {
        retrievalOperationId: retrievalFields.retrieval_operation_id,
        retrievalGeneration: retrievalFields.retrieval_generation,
      } : {}),
    });
    const body = await readBoundedBody(
      response,
      audit.protocol_version === PROVIDER_RETRIEVAL_PROTOCOL ? Math.min(maxBytes, ARTICLE_TEXT_MAX_BYTES) : maxBytes,
      deadline,
      controller,
    );
    const providerRetrieval = audit.protocol_version === PROVIDER_RETRIEVAL_PROTOCOL;
    let responseKeyId: string | null = null;
    for (const [keyId, secret] of responseKeys.keys) {
      const verified = providerRetrieval
        ? await verifyProviderRetrievalAuditResponseHmac(audit as ProviderRetrievalAudit, secret)
        : await verifyDocumentFetchAuditResponseHmac(audit as DocumentFetchAudit, secret);
      if (verified) {
        responseKeyId = keyId;
        break;
      }
    }
    if (!responseKeyId) {
      throw new Error('unsafe_gateway_audit:response_hmac');
    }
    if (providerRetrieval) {
      const providerAudit = audit as ProviderRetrievalAudit;
      if (providerAudit.operation_id !== await deriveRedFoxProviderOperationId(
        providerAudit.input_url,
        providerAudit.retrieval_operation_id,
        providerAudit.retrieval_generation,
      )) {
        throw new Error('unsafe_gateway_provider:operation_identity');
      }
    }
    const bodyCharacters = Array.from(body.text).length;
    if (providerRetrieval && bodyCharacters < 40) throw new Error('unsafe_gateway_provider:body');
    const extractedSizes = providerRetrieval
      ? (audit as ProviderRetrievalAudit).actual_sizes
      : (audit as DocumentFetchAudit).actual_sizes;
    if (extractedSizes.extracted_text_bytes !== body.bytes
      || extractedSizes.extracted_text_characters !== bodyCharacters) {
      throw new Error('unsafe_gateway_audit:body_size_mismatch');
    }
    if (await sha256Hex(body.text) !== audit.body_sha256) {
      throw new Error('unsafe_gateway_audit:body_digest');
    }
    if (providerRetrieval || (audit as DocumentFetchAudit).extraction === 'article_text') {
      validateCompleteArticleText(body.text, body.bytes);
    }
    const excerpt = deriveManualNewsProofExcerpt(body.text);
    body.text = '';
    const excerptBytes = new TextEncoder().encode(excerpt).byteLength;
    const excerptCodePoints = Array.from(excerpt).length;
    const proofExcerpt = audit.proof_excerpt!;
    if (await sha256Hex(excerpt) !== proofExcerpt.sha256
      || excerptBytes !== proofExcerpt.utf8_bytes
      || excerptCodePoints !== proofExcerpt.code_points) {
      throw new Error('unsafe_gateway_audit:proof_excerpt');
    }
    if (providerRetrieval) {
      const providerAudit = audit as ProviderRetrievalAudit;
      return {
        url: providerAudit.canonical_original_url,
        content_type: 'text/plain',
        extraction: 'provider_article_text',
        excerpt,
        redirects: 0,
        fetch_audit: providerAudit,
        response_key_id: responseKeyId,
        title: providerAudit.title,
        publisher: providerAudit.publisher,
        published_at: providerAudit.published_at,
        content_complete: true,
      };
    }
    const directAudit = audit as DocumentFetchAudit;
    return {
      url: directAudit.hops.at(-1)!.url,
      content_type: directAudit.source_content_type,
      extraction: directAudit.extraction,
      excerpt,
      redirects: directAudit.hops.length - 1,
      fetch_audit: directAudit,
      response_key_id: responseKeyId,
      ...(directAudit.document ? {
        title: directAudit.document.title,
        published_at: directAudit.document.published_at,
        selection: directAudit.document.selection,
        content_complete: true as const,
      } : {}),
    };
  } finally {
    controller.abort();
  }
}

function normalizedPublishedAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? value : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export async function searchPublicWeb(
  input: { text: string; date: string },
  deps: { service?: TrustedResearchService; timeoutMs?: number; maxBytes?: number } = {},
): Promise<PublicWebSearchResult[]> {
  const text = input.text.trim();
  if (!text || Array.from(text).length > 4_000 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error('invalid_search_request');
  }
  const { response, deadline, controller } = await postTrusted(
    deps.service, '/v1/search', { query: text, date: input.date, limit: 8 }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new Error('invalid_search_response:content_type');
    const body = await readBoundedBody(response, deps.maxBytes ?? DEFAULT_SEARCH_MAX_BYTES, deadline, controller);
    let raw: unknown;
    try { raw = JSON.parse(body.text); } catch { throw new Error('invalid_search_response:json'); }
    if (!strictObject(raw, ['results']) || !Array.isArray(raw.results) || raw.results.length > 8) {
      throw new Error('invalid_search_response:schema');
    }
    return raw.results.map((value) => {
      if (!strictObject(value, ['url', 'title', 'snippet', 'published_at'])
        || typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.snippet !== 'string') {
        throw new Error('invalid_search_response:item');
      }
      const publishedAt = normalizedPublishedAt(value.published_at);
      if (publishedAt === undefined || !value.title.trim() || !value.snippet.trim()
        || Array.from(value.title).length > 220 || Array.from(value.snippet).length > 1_500) {
        throw new Error('invalid_search_response:item');
      }
      let url: string;
      try { url = validatePublicHttpUrl(value.url).toString(); } catch { throw new Error('invalid_search_response:url'); }
      return { url, title: value.title.trim(), snippet: value.snippet.trim(), published_at: publishedAt };
    });
  } finally {
    controller.abort();
  }
}

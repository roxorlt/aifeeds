// 推文取证（POST /v1/tweet）客户端 —— 2026-09-03。
//
// 背景:owner 提交的 X 链接补录线索全部失败。线索 URL 被交给 /v1/document 直抓 x.com,
// 大陆机房被墙(超时 → 502 → 判 transient → 3 次重试烧掉约 5 分钟),就算网络通了
// x.com 对未登录请求也只返回 JS 外壳。网关侧新开 /v1/tweet 走 ScrapeBadger 推文接口取证。
//
// 契约:dailyVideo 仓 docs/plans/2026-09-03-tweet-evidence-endpoint-contract.md
// 本文件钉住:host 分流、独立 audit 解析/校验、签名不匹配拒绝、错误码 transient/终态分级。

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  fetchTweetEvidence,
  isTweetEvidenceAudit,
  isTransientTweetEvidenceError,
  isTwitterStatusUrl,
  parseTwitterStatusUrl,
  tweetEvidenceErrorCode,
  tweetEvidencePublicMessage,
  TWEET_EVIDENCE_ERROR_SEMANTICS,
  verifyTweetEvidenceAuditResponseHmac,
  type TweetEvidenceAudit,
} from './safe-url-fetch';

const SECRET = '22'.repeat(32);
const KEY_ID = 'response-key-2026-09-03';
const TWEET_URL = 'https://x.com/AnthropicAI/status/1234567890123456789';
const NONCE = 'a'.repeat(32);
const NOW = Date.parse('2026-09-03T04:05:06.000Z');

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(',')}}`;
}

function tweetBody(overrides: Record<string, unknown> = {}) {
  return {
    tweet_id: '1234567890123456789',
    canonical_url: TWEET_URL,
    author: 'Anthropic（@AnthropicAI）',
    author_handle: 'AnthropicAI',
    published_at: 'Wed Sep 03 04:05:06 +0000 2026',
    language: 'en',
    text: '# Anthropic（@AnthropicAI）\n\nWe are releasing a new model.\n\n发布时间：…',
    images: ['https://pbs.twimg.com/media/abc.jpg'],
    media: [],
    metrics: { likes: 12, reposts: 3, replies: 1, quotes: 0, views: 900 },
    ...overrides,
  };
}

function signedAudit(
  bodyText: string,
  overrides: Partial<Record<string, unknown>> = {},
  secret = SECRET,
): TweetEvidenceAudit {
  const unsigned = {
    kind: 'tweet_api',
    provider: 'scrapebadger',
    tweet_id: '1234567890123456789',
    requested_url: TWEET_URL,
    canonical_url: TWEET_URL,
    fetched_at: '2026-09-03T04:05:07.000Z',
    provider_status: 200,
    protocol_version: 'tweet_evidence_v1',
    request_nonce: NONCE,
    request_timestamp: new Date(NOW).toISOString(),
    body_sha256: createHash('sha256').update(bodyText).digest('hex'),
    ...overrides,
  };
  return {
    ...unsigned,
    response_hmac: createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(canonicalJson(unsigned)).digest('hex'),
  } as unknown as TweetEvidenceAudit;
}

function gatewayResponse(bodyText: string, audit: unknown, init: ResponseInit = {}) {
  return new Response(bodyText, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-AIFeeds-Tweet-Audit': encodeURIComponent(JSON.stringify(audit)),
    },
    ...init,
  });
}

function service(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return {
    origin: 'https://gateway.example.test',
    token: 'gateway-token',
    responseKeyId: KEY_ID,
    responseSecret: SECRET,
    fetcher,
    protocolNow: () => NOW,
    nonceFactory: () => NONCE,
  };
}

async function fetchWith(
  body: Record<string, unknown>,
  auditOverrides: Record<string, unknown> = {},
  options: { secret?: string; stripSignature?: boolean } = {},
) {
  const bodyText = JSON.stringify(body);
  let audit: Record<string, unknown> = signedAudit(bodyText, auditOverrides, options.secret ?? SECRET) as never;
  if (options.stripSignature) {
    const { protocol_version: _a, request_nonce: _b, request_timestamp: _c,
      body_sha256: _d, response_hmac: _e, ...rest } = audit;
    audit = rest;
  }
  return fetchTweetEvidence(TWEET_URL, {
    service: service(async () => gatewayResponse(bodyText, audit)),
  });
}

// ── ① host 分流 ──────────────────────────────────────────────────────────────
describe('parseTwitterStatusUrl / host 分流', () => {
  test.each([
    ['https://x.com/AnthropicAI/status/1234567890123456789', 'AnthropicAI', '1234567890123456789'],
    ['https://twitter.com/AnthropicAI/status/1234567890123456789', 'AnthropicAI', '1234567890123456789'],
    ['https://www.x.com/openai/status/42', 'openai', '42'],
    ['https://mobile.twitter.com/openai/status/42', 'openai', '42'],
    ['https://x.com/openai/status/42/', 'openai', '42'],
  ])('识别 %s 为推文链接', (url, handle, tweetId) => {
    const parsed = parseTwitterStatusUrl(url);
    expect(parsed).toEqual({ handle, tweetId, canonicalUrl: `https://x.com/${handle}/status/${tweetId}` });
    expect(isTwitterStatusUrl(url)).toBe(true);
  });

  test.each([
    // 非 status 路径:个人主页 / 搜索页 / 列表页都不是推文取证的对象,不分流。
    'https://x.com/AnthropicAI',
    'https://x.com/search?q=ai',
    'https://x.com/i/lists/123',
    'https://x.com/AnthropicAI/status/abc',
    'https://x.com/AnthropicAI/statuses/123',
    // 相近但不同的 host,绝不能误判。
    'https://notx.com/a/status/1',
    'https://x.com.evil.test/a/status/1',
    'https://fixupx.com/a/status/1',
    'https://example.com/AnthropicAI/status/1234567890123456789',
  ])('不把 %s 判为推文链接', (url) => {
    expect(parseTwitterStatusUrl(url)).toBeNull();
    expect(isTwitterStatusUrl(url)).toBe(false);
  });
});

// ── ② audit 解析与校验 ───────────────────────────────────────────────────────
describe('tweet audit 解析与校验', () => {
  test('接受合法签名 audit,并返回归一化后的推文证据', async () => {
    const evidence = await fetchWith(tweetBody());

    expect(evidence.tweet_id).toBe('1234567890123456789');
    expect(evidence.canonical_url).toBe(TWEET_URL);
    expect(evidence.author_handle).toBe('AnthropicAI');
    // 推文自己的发布时间(Twitter 格式)被归一成 ISO,原文另存。
    expect(evidence.published_at).toBe('2026-09-03T04:05:06.000Z');
    expect(evidence.published_at_raw).toBe('Wed Sep 03 04:05:06 +0000 2026');
    expect(evidence.response_key_id).toBe(KEY_ID);
    expect(isTweetEvidenceAudit(evidence.fetch_audit)).toBe(true);
    expect(evidence.fetch_audit.kind).toBe('tweet_api');
    expect(evidence.fetch_audit.provider).toBe('scrapebadger');
    // 推文 audit 绝不含直抓路径的 IP 钉定字段。
    expect('hops' in evidence.fetch_audit).toBe(false);
  });

  test('audit 里的签名与 keyring 里的历史 key 匹配也接受(支持轮换)', async () => {
    const bodyText = JSON.stringify(tweetBody());
    const oldSecret = '33'.repeat(32);
    const audit = signedAudit(bodyText, {}, oldSecret);
    const evidence = await fetchTweetEvidence(TWEET_URL, {
      service: {
        ...service(async () => gatewayResponse(bodyText, audit)),
        // keyringJson 只放历史 key;当前 key 走 responseKeyId/responseSecret。
        responseKeyringJson: JSON.stringify([{ id: 'response-key-old', secret: oldSecret }]),
      },
    });
    expect(evidence.response_key_id).toBe('response-key-old');
  });

  test.each([
    ['签名用了错误的密钥', { }, { secret: '44'.repeat(32) }, 'unsafe_tweet_audit:signature'],
    ['kind 不是 tweet_api', { kind: 'document' }, {}, 'unsafe_tweet_audit:kind'],
    ['provider 不在白名单', { provider: 'someone_else' }, {}, 'unsafe_tweet_audit:provider'],
    ['requested_url 与请求不一致', { requested_url: 'https://x.com/openai/status/99' }, {}, 'unsafe_tweet_audit:request_mismatch'],
    ['canonical_url 不是合法推文链接', { canonical_url: 'https://x.com/openai' }, {}, 'unsafe_tweet_audit:canonical_url'],
    ['tweet_id 与 URL 里的 id 不一致', { tweet_id: '999' }, {}, 'unsafe_tweet_audit:tweet_id'],
    ['fetched_at 超出时钟偏差', { fetched_at: '2026-09-03T05:30:00.000Z' }, {}, 'unsafe_tweet_audit:fetched_at'],
    ['provider_status 不是合法 HTTP 状态', { provider_status: 42 }, {}, 'unsafe_tweet_audit:provider_status'],
    ['request_nonce 与本次请求不一致', { request_nonce: 'b'.repeat(32) }, {}, 'unsafe_tweet_audit:protocol'],
    ['body_sha256 与响应体不一致', { body_sha256: 'f'.repeat(64) }, {}, 'unsafe_tweet_audit:body_digest'],
  ])('拒绝 %s', async (_case, auditOverrides, options, expected) => {
    await expect(fetchWith(tweetBody(), auditOverrides, options)).rejects.toThrow(expected);
  });

  test('拒绝未签名的 audit —— 云端始终带 nonce 请求,拿不到签名就不是有效证据', async () => {
    await expect(fetchWith(tweetBody(), {}, { stripSignature: true }))
      .rejects.toThrow('unsafe_tweet_audit:signature_required');
  });

  test('拒绝 audit 头缺失 / 超长 / 非法 JSON', async () => {
    const bodyText = JSON.stringify(tweetBody());
    const noHeader = fetchTweetEvidence(TWEET_URL, {
      service: service(async () => new Response(bodyText, {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })),
    });
    await expect(noHeader).rejects.toThrow('unsafe_tweet_audit:missing');

    const badJson = fetchTweetEvidence(TWEET_URL, {
      service: service(async () => new Response(bodyText, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-AIFeeds-Tweet-Audit': '%7Bnot-json' },
      })),
    });
    await expect(badJson).rejects.toThrow('unsafe_tweet_audit:invalid_json');
  });

  test('拒绝 body 与 audit 不自洽(换了另一条推文的正文)', async () => {
    const bodyText = JSON.stringify(tweetBody({ tweet_id: '999', canonical_url: 'https://x.com/openai/status/999' }));
    const audit = signedAudit(bodyText);
    await expect(fetchTweetEvidence(TWEET_URL, {
      service: service(async () => gatewayResponse(bodyText, audit)),
    })).rejects.toThrow('unsafe_tweet_audit:body_mismatch');
  });

  test('正文为空时判为 tweet_empty 终态', async () => {
    const bodyText = JSON.stringify(tweetBody({ text: '   ' }));
    const audit = signedAudit(bodyText);
    await expect(fetchTweetEvidence(TWEET_URL, {
      service: service(async () => gatewayResponse(bodyText, audit)),
    })).rejects.toThrow('tweet_evidence:tweet_empty');
  });

  test('非推文 URL 直接终态拒绝,不发起任何网关请求', async () => {
    let called = 0;
    await expect(fetchTweetEvidence('https://example.com/a/status/1', {
      service: service(async () => { called += 1; return gatewayResponse('{}', {}); }),
    })).rejects.toThrow('tweet_evidence:invalid_tweet_url');
    expect(called).toBe(0);
  });

  test('变异验证:HMAC 改成有域分隔就验不过(契约要求与 signV2DocumentAudit 逐字一致)', async () => {
    const bodyText = JSON.stringify(tweetBody());
    const audit = signedAudit(bodyText);
    expect(await verifyTweetEvidenceAuditResponseHmac(audit, SECRET)).toBe(true);

    const { response_hmac: _drop, ...unsigned } = audit;
    const domainSeparated = {
      ...audit,
      response_hmac: createHmac('sha256', Buffer.from(SECRET, 'hex'))
        .update(`aifeeds-tweet-evidence-v1\0${canonicalJson(unsigned)}`).digest('hex'),
    } as TweetEvidenceAudit;
    expect(await verifyTweetEvidenceAuditResponseHmac(domainSeparated, SECRET)).toBe(false);
  });
});

// ── ③ 错误码映射 ────────────────────────────────────────────────────────────
describe('网关错误码 transient / 终态分级', () => {
  async function failWith(status: number, code: string) {
    return fetchTweetEvidence(TWEET_URL, {
      service: service(async () => new Response(JSON.stringify({ error: code }), {
        status, headers: { 'Content-Type': 'application/json' },
      })),
    }).catch((error) => error as Error);
  }

  test('契约第 4 节的 13 个码全部有明确语义,且只有两个可重试', () => {
    const transient = Object.entries(TWEET_EVIDENCE_ERROR_SEMANTICS)
      .filter(([, value]) => value.transient).map(([code]) => code).sort();
    expect(transient).toEqual(['egress_proxy_unavailable', 'tweet_provider_unavailable']);
    for (const [code, value] of Object.entries(TWEET_EVIDENCE_ERROR_SEMANTICS)) {
      expect(value.message, code).toMatch(/[一-龥]/);
      expect(value.message, code).not.toContain('网关错误');
    }
  });

  test.each([
    [502, 'tweet_provider_unavailable', true],
    [502, 'egress_proxy_unavailable', true],
    // 5xx 但不会自愈:必须从通用 5xx transient 规则里摘出来,否则白白重试三次。
    [502, 'tweet_provider_auth', false],
    [503, 'tweet_provider_not_configured', false],
    [503, 'tweet_response_signing_unavailable', false],
    [404, 'tweet_not_found', false],
    [422, 'tweet_empty', false],
    [400, 'invalid_request', false],
    [400, 'invalid_tweet_url', false],
    [401, 'unauthorized', false],
    [405, 'method_not_allowed', false],
    [413, 'request_too_large', false],
    [415, 'unsupported_media_type', false],
    // /v1/document 的止血码:云端接上新端点后不该再出现,但仍要有人话。
    [422, 'x_link_requires_tweet_api', false],
  ])('HTTP %i %s → transient=%s,并给出可读原因', async (status, code, transient) => {
    const error = await failWith(status, code);
    expect(tweetEvidenceErrorCode(error)).toBe(code);
    expect(isTransientTweetEvidenceError(error)).toBe(transient);
    const message = tweetEvidencePublicMessage(error);
    expect(message).toBeTruthy();
    expect(message).toBe(TWEET_EVIDENCE_ERROR_SEMANTICS[code].message);
  });

  test('网关没给结构化 error 时退回 HTTP 状态码,仍是可读的未知码原因', async () => {
    const error = await fetchTweetEvidence(TWEET_URL, {
      service: service(async () => new Response('gateway down', { status: 504 })),
    }).catch((e) => e as Error);
    expect(tweetEvidenceErrorCode(error)).toBe('gateway_http_504');
    expect(tweetEvidencePublicMessage(error)).toContain('未知错误码');
    // 未知码保守判终态,不盲目重试。
    expect(isTransientTweetEvidenceError(error)).toBe(false);
  });

  test('非推文错误返回 null,不影响既有分类逻辑', () => {
    expect(tweetEvidenceErrorCode(new Error('trusted_gateway_http_502'))).toBeNull();
    expect(isTransientTweetEvidenceError(new Error('trusted_gateway_http_502'))).toBeNull();
    expect(tweetEvidencePublicMessage(new Error('gateway_timeout'))).toBeNull();
  });

  test('变异验证:把 tweet_provider_auth 当成普通 5xx 就会被误判为可重试', () => {
    // 通用规则(isTransientManualLeadError 的 5xx 分支)看到 502 一律判 transient。
    const genericFiveHundred = /^(?:429|5\d\d)$/.test('502');
    expect(genericFiveHundred).toBe(true);
    // 契约表把它摘了出来,判终态。
    expect(TWEET_EVIDENCE_ERROR_SEMANTICS.tweet_provider_auth.transient).toBe(false);
  });
});

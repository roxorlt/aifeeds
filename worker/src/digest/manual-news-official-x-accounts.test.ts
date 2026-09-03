// 官方 X 账号白名单（2026-09-03）。
//
// 一条推文的权威性取决于**账号**而不是域名，所以默认所有推文都是 reliable=false / 'other'。
// 白名单只对「厂商官方账号」这一小撮 handle 开口子：它们发的推文就是一手公告，
// 与官网 blog 同级。handle 只能从**已签名**的 audit.canonical_url 里取，
// 绝不能用未签名的 tweet.author_handle —— 后者是 provider 返回的裸字段，可被伪造。

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  extractManualNewsEvidence,
  officialXAccountActors,
  OFFICIAL_X_ACCOUNT_ACTORS,
} from './manual-news-leads-runtime';
import { manualNewsEvidenceDetail } from './manual-news-leads-api';
import type { PublicDocument } from '../security/safe-url-fetch';
import {
  TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
  TEST_MANUAL_NEWS_RESPONSE_SECRET,
} from './manual-news-signed-evidence.test-fixture';

const TWEET_TEXT = 'We are rolling out Gemini 3.8 Flash to all users today.';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(',')}}`;
}

function tweetDocument(handle: string, tweetId = '2095175881690173885'): PublicDocument {
  const canonicalUrl = `https://x.com/${handle}/status/${tweetId}`;
  const unsigned = {
    kind: 'tweet_api',
    provider: 'scrapebadger',
    tweet_id: tweetId,
    requested_url: canonicalUrl,
    canonical_url: canonicalUrl,
    fetched_at: '2026-09-03T04:05:07.000Z',
    provider_status: 200,
    protocol_version: 'tweet_evidence_v1',
    request_nonce: 'a'.repeat(32),
    request_timestamp: '2026-09-03T04:05:06.000Z',
    body_sha256: createHash('sha256').update(TWEET_TEXT).digest('hex'),
  };
  const fetchAudit = {
    ...unsigned,
    response_hmac: createHmac('sha256', Buffer.from(TEST_MANUAL_NEWS_RESPONSE_SECRET, 'hex'))
      .update(canonicalJson(unsigned)).digest('hex'),
  };
  return {
    response_key_id: TEST_MANUAL_NEWS_RESPONSE_KEY_ID,
    url: canonicalUrl,
    content_type: 'application/json',
    extraction: 'tweet_api',
    excerpt: TWEET_TEXT,
    redirects: 0,
    title: `X @${handle}`,
    publisher: `X @${handle}`,
    published_at: '2026-09-03T04:05:06.000Z',
    fetch_audit: fetchAudit as never,
  };
}

describe('官方 X 账号白名单', () => {
  test('白名单账号的推文算一手公告', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('GoogleAI'));
    expect(evidence).toBeTruthy();
    expect(evidence!.source_type).toBe('official_primary');
    expect(evidence!.reliable).toBe(true);
    // publisher 的写法不变，仍是「X @handle」。
    expect(evidence!.publisher).toBe('X @GoogleAI');
  });

  test('handle 大小写不影响判定', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('OpenAI'));
    expect(evidence!.reliable).toBe(true);
    expect(evidence!.source_type).toBe('official_primary');
  });

  test('不在白名单的账号维持原状：other / 不可靠', async () => {
    const evidence = await extractManualNewsEvidence(tweetDocument('officiallogank'));
    expect(evidence!.source_type).toBe('other');
    expect(evidence!.reliable).toBe(false);
  });

  test('handle 只认已签名的 canonical_url，不认文档上的 publisher 字段', async () => {
    const document = tweetDocument('officiallogank');
    const evidence = await extractManualNewsEvidence({
      ...document,
      publisher: 'X @GoogleAI',
      title: 'X @GoogleAI',
    });
    expect(evidence!.reliable).toBe(false);
    expect(evidence!.source_type).toBe('other');
  });

  test('内置白名单覆盖规格给定的 15 个账号', () => {
    expect([...OFFICIAL_X_ACCOUNT_ACTORS.keys()].sort()).toEqual([
      'aiatmeta', 'alibaba_qwen', 'anthropicai', 'cohere', 'deepseek_ai', 'github',
      'googleai', 'googledeepmind', 'huggingface', 'microsoft', 'mistralai', 'nvidia',
      'openai', 'perplexity_ai', 'xai',
    ]);
    for (const [handle, entry] of OFFICIAL_X_ACCOUNT_ACTORS) {
      expect(handle).toMatch(/^[a-z0-9_]{1,15}$/u);
      expect(entry.actor.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

describe('白名单的 env 覆盖', () => {
  test('合法的 env 值会并入并覆盖内置项', () => {
    const merged = officialXAccountActors({
      MANUAL_NEWS_OFFICIAL_X_HANDLES: 'acmeai=Acme AI, googleai=Google Research',
    } as never);
    expect(merged.get('acmeai')?.actor).toBe('Acme AI');
    expect(merged.get('googleai')?.actor).toBe('Google Research');
    expect(merged.get('openai')?.actor).toBe('OpenAI');
  });

  test('任何一项写坏就整体忽略，并打一条 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = officialXAccountActors({
        MANUAL_NEWS_OFFICIAL_X_HANDLES: 'acmeai=Acme AI,坏掉的条目',
      } as never);
      expect(merged.get('acmeai')).toBeUndefined();
      expect(merged.get('googleai')?.actor).toBe('Google');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('没有 env 值时就是内置白名单', () => {
    expect(officialXAccountActors({} as never)).toEqual(OFFICIAL_X_ACCOUNT_ACTORS);
  });

  test('env 里的 handle / actor 不合法（非法字符、超长）也整体忽略', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(officialXAccountActors({
        MANUAL_NEWS_OFFICIAL_X_HANDLES: 'acme-ai=Acme AI',
      } as never).get('acme-ai')).toBeUndefined();
      expect(officialXAccountActors({
        MANUAL_NEWS_OFFICIAL_X_HANDLES: `acmeai=${'A'.repeat(100)}`,
      } as never).get('acmeai')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('证据列表里的来源标签', () => {
  test('白名单推文标「官方账号推文」，其余推文标普通推文', async () => {
    const official = await extractManualNewsEvidence(tweetDocument('GoogleAI'));
    const ordinary = await extractManualNewsEvidence(tweetDocument('officiallogank'));
    expect(manualNewsEvidenceDetail(official!)).toMatchObject({
      evidence_kind: 'tweet_api',
      source_label: 'X/Twitter 官方账号推文（ScrapeBadger）',
      source_type: 'official_primary',
      reliable: true,
    });
    expect(manualNewsEvidenceDetail(ordinary!)).toMatchObject({
      evidence_kind: 'tweet_api',
      source_label: 'X/Twitter 推文（ScrapeBadger）',
      source_type: 'other',
      reliable: false,
    });
  });
});

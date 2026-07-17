import { gzipSync } from 'node:zlib';
import { describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { parseItemRow } from './item-row';
import { toListItem } from './list-item';
import { handleItemById, handleItems, type Env } from './index';

function row(
  sourceType: string,
  extra: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${sourceType}:fixture`,
    source_type: sourceType,
    source_id: 'fixture',
    source_ref: 'fixture-ref',
    title: 'Fixture title',
    content: 'Fallback content',
    content_translated: 'Fallback translated content',
    author: 'Fixture author',
    handle: 'fixture',
    url: 'https://example.com/fixture',
    media: JSON.stringify([{ type: 'image', url: '/r/list/cover.webp' }]),
    metrics: JSON.stringify({ stars: 42, likes: 7 }),
    published_at: '2026-07-10T00:00:00.000Z',
    scraped_at: '2026-07-10T01:00:00.000Z',
    is_relevant: 1,
    matched_by: 'fixture',
    lang: 'en',
    extra: JSON.stringify(extra),
    deleted_at: null,
    internal_note: 'must never leave a list response',
    hot_score: 9.5,
    feed_rank_score: 8.25,
    ...overrides,
  };
}

function expectNoKeys(value: unknown, forbidden: string[]): void {
  const json = JSON.stringify(value);
  for (const key of forbidden) {
    expect(json, `payload must not contain ${key}`).not.toContain(`"${key}"`);
  }
}

function xArticleDetail(label: string): Record<string, unknown> {
  return {
    article_id: `${label}-article`,
    title: `${label} article title`,
    title_translated: `${label} 文章标题`,
    excerpt: `${label} article excerpt`,
    excerpt_translated: `${label} 文章摘要`,
    cover_image_url: `https://images.example.com/${label}.jpg`,
    summary_text: `${label} summary`,
    author_handle: `${label}_author`,
    author_name: `${label} Author`,
    fetched_at: '2026-07-10T00:00:00.000Z',
    translated_at: '2026-07-10T00:01:00.000Z',
    body: `${label} body `.repeat(2_000),
    body_translated: `${label} 正文`.repeat(2_000),
    body_fetched_at: '2026-07-10T00:02:00.000Z',
    body_fetch_failed_at: null,
    body_translate_skipped_at: null,
    private_pipeline_trace: 'detail-only',
  };
}

function xQuoteDetail(label: string, withNested = false): Record<string, unknown> {
  return {
    id: `${label}-id`,
    author: `${label} Author`,
    handle: `${label}_handle`,
    content: `${label} content `.repeat(120),
    content_translated: `${label} 译文`.repeat(120),
    profile_image_url: `/r/x/${label}-avatar.webp`,
    is_verified: true,
    media: [{
      type: 'image',
      url: `/r/x/${label}-media.webp`,
      width: 1200,
      height: 800,
      alt: `${label} media`,
      private_original: 'detail-only',
    }],
    published_at: '2026-07-10T00:00:00.000Z',
    metrics: {
      replies: 1,
      retweets: 2,
      likes: 3,
      views: 4,
      bookmarks: 5,
      private_score: 999,
    },
    quote_of_id: withNested ? `${label}-nested-id` : undefined,
    quote_of: withNested ? xQuoteDetail(`${label}-nested`, false) : undefined,
    content_resolved_url: `https://x.com/i/article/${label}`,
    content_resolve_failed_at: null,
    x_article: xArticleDetail(label),
    raw_author_avatar_url: 'detail-only',
  };
}

describe('toListItem source DTOs', () => {
  test('GitHub derives one compact cover and never returns README or commit detail', () => {
    const item = toListItem(row('github', {
      ai_category: 'tool',
      ai_summary: 'Compact card summary',
      contributors_inline: [{ login: 'octo', avatar_url: '/r/avatar/octo.webp' }],
      contributors_count: 4,
      daily_rank: 2,
      trending_date_str: '2026-07-10',
      default_branch: 'dev',
      readme_excerpt: [
        '![badge](https://img.shields.io/badge/build-passing.svg)',
        '<img src="./docs/hero.png" alt="hero">',
      ].join('\n'),
      readme_translated: 'very large translated readme',
      recent_commits: [{ sha: 'secret-commit-detail' }],
      workflow_completed_at: '2026-07-10T01:00:00.000Z',
    }, {
      source_id: 'octo/repo',
      title: 'octo/repo',
    }));

    expect(item).toMatchObject({
      id: 'github:fixture',
      source_type: 'github',
      source_id: 'octo/repo',
      extra: {
        ai_category: 'tool',
        ai_summary: 'Compact card summary',
        contributors_count: 4,
        cover_url: 'https://raw.githubusercontent.com/octo/repo/dev/docs/hero.png',
      },
    });
    expect(item).not.toHaveProperty('deleted_at');
    expect(item).not.toHaveProperty('internal_note');
    expect(item).not.toHaveProperty('hot_score');
    expect(item).not.toHaveProperty('feed_rank_score');
    expectNoKeys(item, ['readme_excerpt', 'readme_translated', 'recent_commits']);
  });

  test('GitHub cover derivation rejects executable and non-web URL schemes', () => {
    const item = toListItem(row('github', {
      readme_excerpt: [
        '<img src="javascript:alert(1)">',
        '<img src="mailto:not-an-image@example.com">',
        '<img src="https://images.example.com/safe.png">',
      ].join('\n'),
    }, {
      source_id: 'octo/repo',
      title: 'octo/repo',
    }));

    expect((item.extra as Record<string, unknown>).cover_url)
      .toBe('https://images.example.com/safe.png');

    const badStoredValue = toListItem(row('github', {
      cover_url: 'javascript:alert(2)',
      readme_excerpt: '<img src="https://images.example.com/fallback.png">',
    }, {
      source_id: 'octo/repo',
      title: 'octo/repo',
    }));
    expect((badStoredValue.extra as Record<string, unknown>).cover_url)
      .toBe('https://images.example.com/fallback.png');
  });

  test('X recursively keeps card snapshots while stripping article bodies and unknown nested fields', () => {
    const item = toListItem(row('x_list', {
      profile_image_url: '/r/x/main-avatar.webp',
      quote_of_id: 'quote-id',
      quote_of: xQuoteDetail('quote', true),
      reply_of_id: 'reply-id',
      reply_of: xQuoteDetail('reply'),
      is_retweet: true,
      retweeted_status_id: 'retweet-id',
      retweet_of: xQuoteDetail('retweet', true),
      link_card: {
        url: 'https://example.com/article',
        display_url: 'example.com/article',
        title: 'Link title',
        title_translated: '链接标题',
        description: 'Link description',
        description_translated: '链接描述',
        domain: 'example.com',
        image_url: '/r/x/link.webp',
        video_url: '/r/x/link.mp4',
        private_tracking: 'detail-only',
      },
      x_article: xArticleDetail('main'),
    }));
    const extra = item.extra as Record<string, unknown>;
    const quote = extra.quote_of as Record<string, unknown>;
    const nested = quote.quote_of as Record<string, unknown>;
    const article = extra.x_article as Record<string, unknown>;

    expect(article).toMatchObject({
      title: 'main article title',
      title_translated: 'main 文章标题',
      excerpt: 'main article excerpt',
      excerpt_translated: 'main 文章摘要',
      cover_image_url: 'https://images.example.com/main.jpg',
      author_handle: 'main_author',
      author_name: 'main Author',
      fetched_at: '2026-07-10T00:00:00.000Z',
    });
    expect(quote).toMatchObject({
      id: 'quote-id',
      author: 'quote Author',
      handle: 'quote_handle',
      profile_image_url: '/r/x/quote-avatar.webp',
      metrics: { replies: 1, retweets: 2, likes: 3, views: 4 },
      x_article: { title: 'quote article title' },
    });
    expect(quote.media).toEqual([{
      type: 'image',
      url: '/r/x/quote-media.webp',
      width: 1200,
      height: 800,
      alt: 'quote media',
    }]);
    expect(nested).toMatchObject({
      id: 'quote-nested-id',
      x_article: { title: 'quote-nested article title' },
    });
    expect(nested).not.toHaveProperty('quote_of');
    expect(extra.link_card).toEqual({
      url: 'https://example.com/article',
      display_url: 'example.com/article',
      title: 'Link title',
      title_translated: '链接标题',
      description: 'Link description',
      description_translated: '链接描述',
      domain: 'example.com',
      image_url: '/r/x/link.webp',
      video_url: '/r/x/link.mp4',
    });
    expectNoKeys(item, [
      'body',
      'body_translated',
      'body_fetched_at',
      'body_fetch_failed_at',
      'body_translate_skipped_at',
      'article_id',
      'summary_text',
      'translated_at',
      'fetch_failed_reason',
      'private_pipeline_trace',
      'private_original',
      'private_score',
      'private_tracking',
      'raw_author_avatar_url',
    ]);
  });

  test('HF keeps card metadata and only deep_analysis.tldr', () => {
    const item = toListItem(row('hf_paper', {
      title_zh: '中文标题',
      ai_summary_zh: '一句话摘要',
      ai_keywords: ['agent', 'reasoning'],
      arxiv_categories: ['cs.AI'],
      submitted_by: { user: 'alice', avatar_url: '/r/hf/alice.webp' },
      submitted_on_daily_at: '2026-07-10T00:00:00.000Z',
      paper_authors: [{ name: 'Alice' }, { name: 'Bob' }],
      figure_image: { src_url: '/r/hf/figure.webp', width: 1200, height: 800 },
      deep_analysis: {
        tldr: 'Compact TLDR',
        problem: 'detail-only problem',
        method: 'detail-only method',
        limitations: ['detail-only limitations'],
      },
      discussion_comments: [{ content: 'detail-only discussion' }],
      full_text_zh: 'detail-only full text',
    }));

    expect(item.extra).toEqual({
      title_zh: '中文标题',
      ai_summary_zh: '一句话摘要',
      ai_keywords: ['agent', 'reasoning'],
      arxiv_categories: ['cs.AI'],
      submitted_by: { user: 'alice', avatar_url: '/r/hf/alice.webp' },
      submitted_on_daily_at: '2026-07-10T00:00:00.000Z',
      paper_authors: [{ name: 'Alice' }, { name: 'Bob' }],
      figure_image: { src_url: '/r/hf/figure.webp', width: 1200, height: 800 },
      deep_analysis: { tldr: 'Compact TLDR' },
    });
    expectNoKeys(item, [
      'discussion_comments',
      'full_text_zh',
      'problem',
      'method',
      'limitations',
    ]);
  });

  test.each(['blog', 'podcast'])('%s emits compact excerpts and no body metadata', (sourceType) => {
    const long = '长'.repeat(800);
    const item = toListItem(row(sourceType, {
      title_zh: '中文标题',
      ai_summary_zh: '紧凑摘要',
      cover_image: '/r/feed/cover.webp',
      publisher: { name: 'Publisher', icon_r2: '/r/feed/logo.webp' },
      source_company: 'Publisher',
      blog_name: 'Blog name',
      show_name: 'Podcast name',
      reading_minutes: 6,
      duration_sec: 3600,
      hosts: ['Host'],
      guests: ['Guest'],
      timeline: [{ ts: '00:00', topic: 'Topic', point: 'Point' }],
      excerpt: long,
      excerpt_zh: long,
      body: { html: '<p>detail body metadata</p>' },
      body_markdown: 'detail markdown',
      body_markdown_zh: 'detail translated markdown',
      transcript_text: 'detail transcript',
      transcript_text_zh: 'detail translated transcript',
      shownotes: long,
      shownotes_zh: long,
    }));
    const extra = item.extra as Record<string, unknown>;

    expect(extra.title_zh).toBe('中文标题');
    expect(extra.ai_summary_zh).toBe('紧凑摘要');
    expect(extra.cover_image).toBe('/r/feed/cover.webp');
    expect(extra.publisher).toEqual({ name: 'Publisher', icon_r2: '/r/feed/logo.webp' });
    expect(String(extra.excerpt)).toHaveLength(280);
    expect(String(extra.excerpt_zh)).toHaveLength(280);
    expectNoKeys(item, [
      'body',
      'body_markdown',
      'body_markdown_zh',
      'transcript_text',
      'transcript_text_zh',
      'shownotes',
      'shownotes_zh',
    ]);
  });

  test('podcast derives capped fallback excerpts from internal shownotes', () => {
    const item = toListItem(row('podcast', {
      shownotes: 'english '.repeat(100),
      shownotes_zh: '中文'.repeat(300),
    }));
    const extra = item.extra as Record<string, unknown>;

    expect(String(extra.excerpt)).toHaveLength(280);
    expect(String(extra.excerpt_zh)).toHaveLength(280);
    expectNoKeys(item, ['shownotes', 'shownotes_zh']);
  });

  test('positive source allowlists preserve current card fields for the remaining feeds', () => {
    const x = toListItem(row('x_list', {
      profile_image_url: '/r/x/avatar.webp',
      thread_root_id: 'root',
      quote_of: { id: 'quoted', content: 'quoted content' },
      reply_to_id: 'parent',
      reply_of_id: 'parent',
      reply_of: { id: 'parent', content: 'parent content' },
      link_card: { title: 'Linked page', image_url: '/r/x/link.webp' },
      x_article: { title: 'Article', excerpt: 'Article excerpt' },
      is_retweet: true,
      retweeted_status_id: 'retweeted',
      retweet_of: { id: 'retweeted', content: 'retweeted content' },
      unknown_internal: 'drop me',
    }));
    const ph = toListItem(row('product_hunt', {
      ai_summary: 'summary',
      ai_category: 'ai_agent',
      launch_date_pt: '2026-07-10',
      daily_rank: 4,
      display_rank: 3,
      makers: [{ handle: 'maker' }],
      top_comments: [{ body: 'detail only' }],
    }));
    const clawhub = toListItem(row('clawhub', {
      category: 'mcp-tools',
      latest_version: '1.2.3',
      owner_image: '/r/clawhub/owner.webp',
      summary_translated: 'summary',
      files_manifest: [{ path: 'detail only' }],
    }));
    const hdx = toListItem(row('huodongxing', {
      city: '北京',
      district: '朝阳',
      detail_enriched_at: 1,
      start_time: '2026-07-12T10:00:00+08:00',
      end_time: '2026-07-12T12:00:00+08:00',
      start_short: '07/12 10:00',
      is_online: false,
      is_free: true,
      ticket_tiers: [{ price: 0, price_str: '免费' }],
      organizer: { name: 'Organizer' },
      contact: { org_phone: 'detail only' },
    }));

    expect(x.extra).toEqual({
      profile_image_url: '/r/x/avatar.webp',
      thread_root_id: 'root',
      quote_of: { id: 'quoted', content: 'quoted content' },
      reply_to_id: 'parent',
      reply_of_id: 'parent',
      reply_of: { id: 'parent', content: 'parent content' },
      link_card: { title: 'Linked page', image_url: '/r/x/link.webp' },
      x_article: { title: 'Article', excerpt: 'Article excerpt' },
      is_retweet: true,
      retweeted_status_id: 'retweeted',
      retweet_of: { id: 'retweeted', content: 'retweeted content' },
    });
    expect(ph.extra).toEqual({
      ai_summary: 'summary',
      ai_category: 'ai_agent',
      launch_date_pt: '2026-07-10',
      daily_rank: 4,
      display_rank: 3,
      makers: [{ handle: 'maker' }],
    });
    expect(ph.media).toEqual([{ type: 'image', url: '/r/list/cover.webp' }]);
    expect(clawhub.extra).toEqual({
      category: 'mcp-tools',
      latest_version: '1.2.3',
      owner_image: '/r/clawhub/owner.webp',
      summary_translated: 'summary',
    });
    expect(hdx.extra).toEqual({
      city: '北京',
      district: '朝阳',
      detail_enriched_at: 1,
      start_time: '2026-07-12T10:00:00+08:00',
      end_time: '2026-07-12T12:00:00+08:00',
      start_short: '07/12 10:00',
      is_online: false,
      is_free: true,
      ticket_tiers: [{ price: 0, price_str: '免费' }],
      organizer: { name: 'Organizer' },
    });
  });

  test('mapping an already-parsed row does not mutate the raw/detail object', () => {
    const rawExtra = {
      deep_analysis: { tldr: 'TLDR', method: 'detail method' },
      discussion_comments: [{ id: 'comment' }],
      unknown_internal: { keep: true },
    };
    const raw = row('hf_paper', rawExtra, {
      extra: rawExtra,
      media: [{ type: 'image', url: '/r/hf/cover.webp' }],
      metrics: { upvotes: 12 },
    });
    const before = structuredClone(raw);

    const list = toListItem(raw);

    expect(raw).toEqual(before);
    expect(list.extra).not.toBe(rawExtra);
    expect((list.extra as Record<string, unknown>).deep_analysis).toEqual({ tldr: 'TLDR' });
    expect(rawExtra.deep_analysis).toEqual({ tldr: 'TLDR', method: 'detail method' });
    expect(rawExtra.discussion_comments).toEqual([{ id: 'comment' }]);
  });

  test('top-level media and card variants use positive nested DTO allowlists', () => {
    const item = toListItem(row('product_hunt', {
      ai_summary: 'summary',
    }, {
      media: JSON.stringify([{
        type: 'image',
        role: 'gallery',
        url: '/r/ph/original.jpg',
        width: 1200,
        height: 750,
        card_variants: [{
          url: '/r/ph/card/hash-w400.webp',
          width: 400,
          height: 250,
          format: 'webp',
          bytes: 24_000,
          internal_hash: 'must-not-leak',
        }],
        card_preview_status: 'ready',
        private_original: 'must-not-leak',
      }]),
    }));

    expect(item.media).toEqual([{
      type: 'image',
      role: 'gallery',
      url: '/r/ph/original.jpg',
      width: 1200,
      height: 750,
      card_variants: [{
        url: '/r/ph/card/hash-w400.webp',
        width: 400,
        height: 250,
        format: 'webp',
      }],
      card_preview_status: 'ready',
    }]);
    expectNoKeys(item, ['bytes', 'internal_hash', 'private_original']);
  });

  test('scalar card variants omit ingestion-only byte accounting', () => {
    const item = toListItem(row('blog', {
      cover_image: '/r/blog/original.jpg',
      cover_variant_source: '/r/blog/original.jpg',
      cover_image_variants: [{
        url: '/r/blog/card/hash-w400.webp',
        width: 400,
        height: 250,
        format: 'webp',
        bytes: 21_000,
      }],
    }));

    expect((item.extra as Record<string, unknown>).cover_image_variants).toEqual([{
      url: '/r/blog/card/hash-w400.webp',
      width: 400,
      height: 250,
      format: 'webp',
    }]);
    expectNoKeys(item, ['bytes']);
  });

  test('unenriched Huodongxing cards keep raw time and location fallbacks', () => {
    const item = toListItem(row('huodongxing', {
      detail_enriched_at: null,
      time_raw: '明天 19:30',
      location_raw: '北京朝阳',
      contact: { org_phone: 'detail-only' },
    }));

    expect(item.extra).toEqual({
      time_raw: '明天 19:30',
      location_raw: '北京朝阳',
      detail_enriched_at: null,
    });
  });
});

describe('list/detail isolation', () => {
  test.each([
    ['github', { readme_excerpt: 'README', readme_translated: '译文', recent_commits: [{ sha: 'abc' }] }, ['readme_excerpt', 'readme_translated', 'recent_commits']],
    ['hf_paper', { deep_analysis: { tldr: 'TLDR', method: 'full method' }, discussion_comments: [{ id: 'c1' }] }, ['method', 'discussion_comments']],
    ['blog', { body_markdown: '# Full body', body_markdown_zh: '# 完整正文' }, ['body_markdown', 'body_markdown_zh']],
    ['podcast', { transcript_text: 'Full transcript', shownotes: 'Full shownotes' }, ['transcript_text', 'shownotes']],
  ])('%s detail fixture keeps full fields while list fixture strips them', (sourceType, extra, forbidden) => {
    const fixture = row(sourceType, extra);
    const list = toListItem(fixture);
    const detail = parseItemRow(fixture, true);

    expectNoKeys(list, forbidden);
    expect(JSON.stringify(detail.extra)).toBe(JSON.stringify(extra));
  });

  test('item detail keeps full heavy fields for both the root and thread siblings', async () => {
    const root = row('x_list', {
      thread_root_id: 'thread-root',
      top_comments: [{ text: 'root detail' }],
      x_article: { title: 'Root article', body: 'root full body' },
    }, {
      id: 'x_list:root',
      source_id: 'root',
    });
    const sibling = row('x_list', {
      thread_root_id: 'thread-root',
      discussion_comments: [{ text: 'sibling detail' }],
      files_manifest: [{ path: 'sibling/detail.md' }],
      x_article: { title: 'Sibling article', body: 'sibling full body' },
    }, {
      id: 'x_list:sibling',
      source_id: 'sibling',
    });
    let prepareCall = 0;
    const env = {
      DB: {
        prepare: () => {
          const call = prepareCall++;
          const statement = {
            bind: () => statement,
            first: async () => (call === 0 ? root : null),
            all: async () => ({ results: call === 1 ? [sibling] : [] }),
          };
          return statement;
        },
      },
    } as unknown as Env;

    const response = await handleItemById(
      new Request('https://api.ai-feeds.com/api/items/x_list%3Aroot'),
      env,
      'x_list:root',
    );
    const payload = await response.json() as {
      item: { extra: Record<string, unknown> };
      siblings: Array<{ extra: Record<string, unknown> }>;
    };

    expect(payload.item.extra.top_comments).toEqual([{ text: 'root detail' }]);
    expect(payload.item.extra.x_article).toEqual({ title: 'Root article', body: 'root full body' });
    expect(payload.siblings).toHaveLength(1);
    expect(payload.siblings[0].extra.discussion_comments).toEqual([{ text: 'sibling detail' }]);
    expect(payload.siblings[0].extra.files_manifest).toEqual([{ path: 'sibling/detail.md' }]);
    expect(payload.siblings[0].extra.x_article).toEqual({
      title: 'Sibling article',
      body: 'sibling full body',
    });
  });
});

describe('/api/items list handler integration', () => {
  test.each([
    ['x_list', '', { unknown_internal: 'drop me' }],
    ['github', '?source_type=github', { readme_excerpt: 'README', unknown_internal: 'drop me' }],
    ['product_hunt', '?source_type=product_hunt', { top_comments: [{ body: 'detail' }], unknown_internal: 'drop me' }],
    ['clawhub', '?source_type=clawhub', { files_manifest: [{ path: 'detail' }], unknown_internal: 'drop me' }],
    ['huodongxing', '?source_type=huodongxing', { contact: { org_phone: 'detail' }, unknown_internal: 'drop me' }],
    ['hf_paper', '?source_type=hf_paper', { discussion_comments: [{ content: 'detail' }], unknown_internal: 'drop me' }],
    ['blog', '?source_type=blog', { body_markdown: 'detail', unknown_internal: 'drop me' }],
    ['podcast', '?source_type=podcast', { transcript_text: 'detail', unknown_internal: 'drop me' }],
  ])('%s response is built through the positive list DTO', async (sourceType, query, extra) => {
    const fixture = row(sourceType, extra);
    const statement = {
      bind: () => statement,
      all: async () => ({
        results: [fixture],
        meta: { timings: { sql_duration_ms: 1 } },
      }),
    };
    const env = {
      DB: { prepare: () => statement },
    } as unknown as Env;

    const response = await handleItems(
      new Request(`https://api.ai-feeds.com/api/items${query}`),
      env,
    );
    const payload = await response.json() as { items: Array<Record<string, unknown>> };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).not.toHaveProperty('internal_note');
    expect(payload.items[0]).not.toHaveProperty('deleted_at');
    expect(payload.items[0].extra).not.toHaveProperty('unknown_internal');
  });
});

describe('representative 30-item list budgets', () => {
  function sizes(
    sourceType: string,
    extra: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): { identity: number; gzip: number } {
    const items = Array.from({ length: 30 }, (_, index) => toListItem(row(sourceType, extra, {
      id: `${sourceType}:${index}`,
      source_id: String(index),
      ...overrides,
    })));
    const serialized = Buffer.from(JSON.stringify({ items }));
    return { identity: serialized.byteLength, gzip: gzipSync(serialized).byteLength };
  }

  test('GitHub stays within identity and gzip budgets despite large hidden detail fields', () => {
    const measured = sizes('github', {
      ai_summary: 'A compact summary '.repeat(12),
      readme_excerpt: '<img src="https://example.com/hero.png">\n'.repeat(600),
      readme_translated: '译'.repeat(30_000),
      recent_commits: Array.from({ length: 100 }, (_, i) => ({ sha: String(i), message: 'commit'.repeat(20) })),
    });
    expect(measured.identity).toBeLessThanOrEqual(150 * 1024);
    expect(measured.gzip).toBeLessThanOrEqual(80 * 1024);
  });

  test('x_list stays within the identity budget across full quote, reply, and retweet snapshots', () => {
    const variants = [
      { quote_of: xQuoteDetail('quote', true) },
      { reply_of: xQuoteDetail('reply', false) },
      { retweet_of: xQuoteDetail('retweet', true), is_retweet: true },
    ];
    const items = Array.from({ length: 30 }, (_, index) => toListItem(row('x_list', {
      profile_image_url: '/r/x/avatar.webp',
      link_card: {
        title: 'Link title',
        description: 'Link description '.repeat(30),
        image_url: '/r/x/link.webp',
      },
      x_article: xArticleDetail('main'),
      ...variants[index % variants.length],
    }, {
      id: `x_list:${index}`,
      source_id: String(index),
      content: 'Main tweet '.repeat(40),
      content_translated: '主推译文'.repeat(80),
    })));
    const identity = Buffer.byteLength(JSON.stringify({ items }));

    expect(identity).toBeLessThanOrEqual(150 * 1024);
  });

  const otherFeedBudgetCases: Array<[
    string,
    Record<string, unknown>,
    Record<string, unknown>?,
  ]> = [
    ['product_hunt', {
      ai_summary: 'Product summary '.repeat(20),
      ai_category: 'ai_agent',
      launch_date_pt: '2026-07-10',
      daily_rank: 1,
      makers: Array.from({ length: 8 }, (_, i) => ({
        name: `Maker ${i}`,
        handle: `maker${i}`,
        avatar_url: `/r/ph/maker-${i}.webp`,
        profile_url: `https://producthunt.com/@maker${i}`,
      })),
      top_comments: Array(50).fill({ body_html: 'detail '.repeat(200) }),
    }, {
      media: JSON.stringify(Array.from({ length: 8 }, (_, i) => ({
        type: 'image',
        role: i === 0 ? 'logo' : 'gallery',
        url: `/r/ph/media-${i}.webp`,
        width: 1200,
        height: 800,
      }))),
    }],
    ['clawhub', {
      category: 'mcp-tools',
      latest_version: '1.2.3',
      owner_image: '/r/clawhub/owner.webp',
      summary_translated: 'Skill summary '.repeat(20),
      files_manifest: Array(100).fill({ path: 'detail', content: 'x'.repeat(500) }),
    }, { content: 'README '.repeat(5_000), content_translated: '文档'.repeat(5_000) }],
    ['huodongxing', {
      city: '北京',
      district: '朝阳',
      detail_enriched_at: 1,
      start_time: '2026-07-12T10:00:00+08:00',
      end_time: '2026-07-12T12:00:00+08:00',
      start_short: '07/12 10:00',
      location_raw: '北京朝阳',
      is_online: false,
      is_free: false,
      ticket_tiers: Array.from({ length: 6 }, (_, i) => ({
        sn: i,
        name: `Ticket ${i}`,
        price: i * 99,
        price_str: `¥${i * 99}`,
      })),
      organizer: {
        name: 'Organizer',
        avatar_url: '/r/hdx/organizer.webp',
        fans: 12_345,
        is_certified_company: true,
        is_vip_gold: true,
      },
      guests: Array(50).fill({ description: 'detail '.repeat(200) }),
      contact: { org_description: 'detail '.repeat(5_000) },
    }, {
      media: JSON.stringify([{ type: 'image', role: 'thumbnail', url: '/r/hdx/cover.webp' }]),
    }],
    ['hf_paper', { deep_analysis: { tldr: 'TLDR '.repeat(30), method: 'detail '.repeat(2_000) }, discussion_comments: Array(100).fill({ content: 'detail' }) }],
    ['blog', { ai_summary_zh: '摘要'.repeat(50), body_markdown: 'body'.repeat(20_000) }],
    ['podcast', { ai_summary_zh: '摘要'.repeat(50), transcript_text: 'transcript'.repeat(20_000) }],
    ['youtube', { internal_payload: 'detail '.repeat(20_000) }, {
      content: 'Video description '.repeat(20),
      media: JSON.stringify([{ type: 'video', url: 'https://youtube.com/watch?v=fixture' }]),
    }],
  ];

  test.each(otherFeedBudgetCases)('%s stays within the identity budget', (sourceType, extra, overrides = {}) => {
    expect(sizes(sourceType, extra, overrides).identity).toBeLessThanOrEqual(150 * 1024);
  });
});

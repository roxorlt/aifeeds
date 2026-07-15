import { describe, expect, test } from 'vitest';
import {
  cleanBlogEditorialImages,
  cleanBlogMediaJson,
  runTheVergeEditorialImageCleanup,
} from './blog-editorial-image-cleanup';
import type { Env } from '../index';

describe('cleanBlogEditorialImages — The Verge 作者头像存量清理', () => {
  test('同时清理 assets、原文/中译 markdown、R2 别名与头像封面，保留正常题图', () => {
    const avatar =
      'https://platform.theverge.com/wp-content/uploads/sites/2/chorus/author_profile_images/195810/EMMA_ROTH.0.jpg?quality=90&w=2400';
    const avatarR2 = 'https://api.ai-feeds.com/r/blog/avatar-content-hash.jpg';
    const hero =
      'https://platform.theverge.com/wp-content/uploads/sites/2/2026/03/STK155_OPEN_AI_4_CVirginia_D.png?quality=90&w=2400';
    const heroR2 = '/r/blog/hero-content-hash.png';
    const result = cleanBlogEditorialImages({
      feed_key: 'the-verge',
      cover_image: avatarR2,
      body: {
        source: 'rss_full',
        extracted_at: '2026-07-15T00:00:00.000Z',
        assets: [
          { url: avatar, r2_url: avatarR2, kind: 'image', role: 'inline' },
          { url: hero, r2_url: heroR2, kind: 'image', role: 'inline', width: 1600, height: 900 },
        ],
      },
      body_markdown: `正文\n\n![Emma](/r/blog/avatar-content-hash.jpg)\n\n![Hero](${heroR2})`,
      body_markdown_zh: `中文正文\n\n![作者](${avatar})\n\n![题图](${heroR2})`,
    });

    expect(result.changed).toBe(true);
    expect(result.removedImages).toBe(1);
    expect(result.patch.body?.assets?.map((asset) => asset.url)).toEqual([hero]);
    expect(result.patch.body_markdown).not.toContain('avatar-content-hash');
    expect(result.patch.body_markdown_zh).not.toContain('author_profile_images');
    expect(result.patch.body_markdown).toContain(heroR2);
    expect(result.patch.body_markdown_zh).toContain(heroR2);
    expect(result.patch.cover_image).toBe(heroR2);
    expect(result.patch.editorial_image_blocked_urls).toContain('/r/blog/avatar-content-hash.jpg');
    expect(result.blockedUrls).toContain('/r/blog/avatar-content-hash.jpg');
  });

  test('正常人物新闻照片和普通 hero 不误删', () => {
    const personPhoto =
      'https://platform.theverge.com/wp-content/uploads/sites/2/2026/01/gettyimages-2194484502.jpg?quality=90&w=2400';
    const result = cleanBlogEditorialImages({
      feed_key: 'the-verge',
      cover_image: personPhoto,
      body: {
        source: 'rss_full',
        extracted_at: '2026-07-15T00:00:00.000Z',
        assets: [{ url: personPhoto, kind: 'image', role: 'inline' }],
      },
      body_markdown: `![Demis Hassabis](${personPhoto})`,
    });

    expect(result.changed).toBe(false);
    expect(result.removedImages).toBe(0);
  });

  test('未命中图片规则时正文保持逐字节不变，不因清理器顺手 trim', () => {
    const body = '  正文保留原始空白  \n';
    const result = cleanBlogEditorialImages({
      feed_key: 'the-verge',
      body_markdown: body,
    });

    expect(result.changed).toBe(false);
    expect(result.patch.body_markdown).toBeUndefined();
  });

  test('已有持久 blocked URL 在 body 映射删除后仍向 media 清理阶段透传', () => {
    const result = cleanBlogEditorialImages({
      feed_key: 'the-verge',
      editorial_image_blocked_urls: ['/r/blog/legacy-avatar.jpg'],
      body_markdown: '只有正文',
    });

    expect(result.changed).toBe(false);
    expect(result.blockedUrls).toContain('/r/blog/legacy-avatar.jpg');
  });
});

describe('cleanBlogMediaJson', () => {
  test('用持久 blocked URL 清理 items.media，绝对/相对 R2 视为同一资源', () => {
    const media = JSON.stringify([
      { type: 'image', url: 'https://api.ai-feeds.com/r/blog/avatar-hash.jpg' },
      { type: 'image', url: '/r/blog/hero-hash.jpg' },
    ]);
    const result = cleanBlogMediaJson(media, new Set(['/r/blog/avatar-hash.jpg']));

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.media || '[]')).toEqual([
      { type: 'image', url: '/r/blog/hero-hash.jpg' },
    ]);
  });
});

interface FakeItem {
  id: string;
  source_type: string;
  extra: Record<string, unknown>;
  media?: string | null;
}

function makeEnv(items: FakeItem[], opts: { conflictId?: string } = {}) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const actionable = (item: FakeItem, sql: string) =>
    item.source_type === 'blog' &&
    (item.extra.feed_key === 'the-verge' ||
      (/id LIKE 'blog:the-verge:%'/.test(sql) && item.id.startsWith('blog:the-verge:'))) &&
    item.extra.editorial_image_cleaned_at == null &&
    (!/workflow_completed_at/.test(sql) || item.extra.workflow_completed_at != null) &&
    (!/blog_media_r2_at/.test(sql) || item.extra.blog_media_r2_at != null);

  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async all<T>() {
          const limit = Number(binds[0]) || 100;
          const results = items
            .filter((item) => actionable(item, sql))
            .slice(0, limit)
            .map((item) => ({ id: item.id, extra: JSON.stringify(item.extra), media: item.media ?? null }));
          return { results: results as unknown as T[] };
        },
        async first<T>() {
          return { c: items.filter((item) => actionable(item, sql)).length } as unknown as T;
        },
        async run() {
          updates.push({ sql, binds });
          const hasCas = /AND extra = \?/i.test(sql);
          const id = String(binds.at(hasCas ? -3 : -1));
          const item = items.find((candidate) => candidate.id === id);
          if (!item) return { success: true };
          if (opts.conflictId === id) {
            item.extra.concurrent_write = 'won';
            return { success: true, meta: { changes: 0 } };
          }
          if (hasCas) {
            const extraMatches = JSON.stringify(item.extra) === String(binds.at(-2));
            const mediaMatches = String(item.media ?? '') === String(binds.at(-1) ?? '');
            if (!extraMatches || !mediaMatches) return { success: true, meta: { changes: 0 } };
          }
          const paths = [...sql.matchAll(/'\$\.([a-zA-Z0-9_]+)'/g)].map((match) => match[1]);
          paths.forEach((path, index) => {
            const value = binds[index];
            item.extra[path] = path === 'body' ? JSON.parse(String(value)) : value;
          });
          if (/\bmedia\s*=\s*\?/i.test(sql)) {
            item.media = String(binds[paths.length]);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };

  return { env: { DB } as unknown as Env, updates };
}

describe('runTheVergeEditorialImageCleanup', () => {
  test('分页清理 The Verge 全部存量并推进单调游标', async () => {
    const avatar = 'https://platform.theverge.com/x/HAYDEN_BLURPLE.jpg?w=2400';
    const completed = {
      workflow_completed_at: '2026-07-15T00:00:00.000Z',
      blog_media_r2_at: '2026-07-15T00:00:00.000Z',
    };
    const items: FakeItem[] = [
      {
        id: 'blog:the-verge:dirty',
        source_type: 'blog',
        extra: {
          ...completed,
          feed_key: 'the-verge',
          body: {
            source: 'rss_full',
            extracted_at: 'x',
            assets: [{ url: avatar, r2_url: '/r/blog/avatar.jpg', kind: 'image', role: 'inline' }],
          },
          body_markdown: '正文\n\n![作者](/r/blog/avatar.jpg)',
        },
        media: JSON.stringify([
          { type: 'image', url: 'https://api.ai-feeds.com/r/blog/avatar.jpg' },
          { type: 'image', url: '/r/blog/hero.jpg' },
        ]),
      },
      {
        id: 'blog:the-verge:clean',
        source_type: 'blog',
        extra: { ...completed, feed_key: 'the-verge', body_markdown: '只有正文' },
      },
      {
        id: 'blog:the-verge:legacy-without-feed-key',
        source_type: 'blog',
        extra: { ...completed, body_markdown: `![作者](${avatar})` },
      },
      {
        id: 'blog:the-verge:still-running',
        source_type: 'blog',
        extra: { feed_key: 'the-verge', body_markdown: `![作者](${avatar})` },
      },
      {
        id: 'blog:other:dirty',
        source_type: 'blog',
        extra: { feed_key: 'other', body_markdown: `![作者](${avatar})` },
      },
    ];
    const { env, updates } = makeEnv(items);

    const result = await runTheVergeEditorialImageCleanup(env, { limit: 100, dry: false });

    expect(result).toMatchObject({ scanned: 3, fixed: 2, removedImages: 2, conflicts: 0, remaining: 0 });
    expect(updates).toHaveLength(3);
    expect(items[0].extra.body_markdown).not.toContain('avatar.jpg');
    expect(items[0].media).not.toContain('avatar.jpg');
    expect(items[0].media).toContain('hero.jpg');
    expect(items[0].extra.editorial_image_blocked_urls).toContain('/r/blog/avatar.jpg');
    expect(items[0].extra.editorial_image_cleaned_at).toBeTruthy();
    expect(items[1].extra.editorial_image_cleaned_at).toBeTruthy();
    expect(items[2].extra.editorial_image_cleaned_at).toBeTruthy();
    expect(items[3].extra.editorial_image_cleaned_at).toBeUndefined();
    expect(items[4].extra.editorial_image_cleaned_at).toBeUndefined();
  });

  test('dry 模式只统计，不写数据也不推进游标', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:the-verge:dirty',
        source_type: 'blog',
        extra: {
          workflow_completed_at: '2026-07-15T00:00:00.000Z',
          blog_media_r2_at: '2026-07-15T00:00:00.000Z',
          feed_key: 'the-verge',
          body_markdown: '![作者](https://platform.theverge.com/x/DOM_BLURPLE-1.jpg?w=2400)',
        },
      },
    ];
    const { env, updates } = makeEnv(items);
    const result = await runTheVergeEditorialImageCleanup(env, { limit: 100, dry: true });

    expect(result).toMatchObject({ scanned: 1, fixed: 1, remaining: 1 });
    expect(updates).toHaveLength(0);
    expect(items[0].extra.editorial_image_cleaned_at).toBeUndefined();
  });

  test('SELECT 后 extra 被并发 workflow 改写时 CAS 拒绝覆盖且不推进游标', async () => {
    const item: FakeItem = {
      id: 'blog:the-verge:conflict',
      source_type: 'blog',
      extra: {
        feed_key: 'the-verge',
        workflow_completed_at: '2026-07-15T00:00:00.000Z',
        blog_media_r2_at: '2026-07-15T00:00:00.000Z',
        body_markdown:
          '![作者](https://platform.theverge.com/wp-content/uploads/sites/2/2025/01/JAY_BLURPLE.jpg?w=2400)',
      },
    };
    const { env } = makeEnv([item], { conflictId: item.id });

    const result = await runTheVergeEditorialImageCleanup(env, { limit: 100, dry: false });

    expect(result).toMatchObject({ scanned: 1, fixed: 0, conflicts: 1, remaining: 1 });
    expect(item.extra.concurrent_write).toBe('won');
    expect(item.extra.editorial_image_cleaned_at).toBeUndefined();
  });
});

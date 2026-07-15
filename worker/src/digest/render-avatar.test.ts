import { describe, test, expect } from 'vitest';
import { isSkippableInlineImage, renderItem, type RenderRow } from './render';

const API = 'https://api.ai-feeds.com';

function newsRow(extra: Record<string, unknown>): RenderRow {
  return {
    id: 'blog:the-verge:deadbeef',
    title: '标题',
    content: '',
    content_translated: null,
    author: null,
    handle: null,
    url: 'https://www.theverge.com/post',
    media: null,
    extra: JSON.stringify(extra),
  };
}

// Fix 2.2：isSkippableInlineImage 补署名头像形态(管正文首图回退路径)。
describe('isSkippableInlineImage — 署名头像形态过滤', () => {
  // ── 应拦(头像/作者署名图)──
  test('Verge BLURPLE 作者头像被拦', () => {
    expect(isSkippableInlineImage('https://platform.theverge.com/wp-content/uploads/sites/2/2025/02/TERRENCE_BLURPLE.jpg?quality=90&w=2400')).toBe(true);
  });
  test('作者头像小尺寸变体(w=96)被拦', () => {
    expect(isSkippableInlineImage('https://cdn/pic.jpg?w=96')).toBe(true);
  });
  test('/authors/ 路径头像被拦', () => {
    expect(isSkippableInlineImage('https://cdn.example.com/authors/jane-doe.jpg')).toBe(true);
  });
  test('gravatar 头像被拦', () => {
    expect(isSkippableInlineImage('https://secure.gravatar.com/avatar/abc123?s=200')).toBe(true);
  });
  test('文件名含 headshot 被拦', () => {
    expect(isSkippableInlineImage('https://cdn/john-headshot.png')).toBe(true);
  });
  test('avatar 关键词被拦', () => {
    expect(isSkippableInlineImage('https://cdn/user_avatar_512.jpg')).toBe(true);
  });

  // ── 原有规则仍生效 ──
  test('svg 仍被拦', () => {
    expect(isSkippableInlineImage('https://cdn/icon.svg')).toBe(true);
  });
  test('shields badge 仍被拦', () => {
    expect(isSkippableInlineImage('https://img.shields.io/badge/x')).toBe(true);
  });
  test('data uri 仍被拦', () => {
    expect(isSkippableInlineImage('data:image/png;base64,AAAA')).toBe(true);
  });

  // ── 不该误伤(正常题图)──
  test('正常 hero(大尺寸,无头像标记)不拦', () => {
    expect(isSkippableInlineImage('https://platform.theverge.com/wp-content/uploads/chorus_asset/file/STK483_EDUCATION_C.jpg?quality=90&w=2400')).toBe(false);
  });
  test('普通题图 w=1200 不拦', () => {
    expect(isSkippableInlineImage('https://cdn/article-hero.jpg?w=1200')).toBe(false);
  });
  test('文件名普通不拦', () => {
    expect(isSkippableInlineImage('https://image.jiqizhixin.com/uploads/article/doubao.jpg')).toBe(false);
  });
});

// 端到端:默认 news 路径(daily-api/codex)封面回退跳过头像题图,取到真 hero。
describe('renderItem news — 头像题图回退跳过', () => {
  test('正文首图为作者头像时,回退跳到第二张真 hero', () => {
    const row = newsRow({
      body: {
        assets: [
          { url: 'https://platform.theverge.com/x/2025/02/TERRENCE_BLURPLE.jpg?w=2400', kind: 'image', role: 'inline' },
          { url: 'https://platform.theverge.com/x/STK483_EDUCATION_C.jpg?w=2400', kind: 'image', role: 'inline' },
        ],
      },
    });
    const item = renderItem('news', row, 1, API);
    // 头像被跳过 → 采用真 hero(外链在默认路径仍直用)
    expect(item.cover).toContain('STK483_EDUCATION_C');
    expect(item.cover).not.toContain('BLURPLE');
  });

  test('正常题图不受影响(回归)', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://cdn/normal-hero.jpg', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API);
    expect(item.cover).toBe('https://cdn/normal-hero.jpg');
  });

  test('cover_image 是 The Verge 作者头像时跳过并采用正文真题图', () => {
    const row = newsRow({
      cover_image:
        'https://platform.theverge.com/wp-content/uploads/sites/2/chorus/author_profile_images/195810/EMMA_ROTH.0.jpg?quality=90&w=2400',
      body: {
        assets: [
          {
            url: 'https://platform.theverge.com/wp-content/uploads/sites/2/2026/03/real-hero.jpg?w=2400',
            kind: 'image',
            role: 'inline',
          },
        ],
      },
    });

    const item = renderItem('news', row, 1, API);
    expect(item.cover).toContain('real-hero.jpg');
    expect(item.cover).not.toContain('author_profile_images');
  });

  test('row.media 和 body.assets 中的作者头像均不进入日报 media', () => {
    const avatar =
      'https://platform.theverge.com/wp-content/uploads/sites/2/2025/01/HAYDEN_BLURPLE.jpg?quality=90&w=2400';
    const hero =
      'https://platform.theverge.com/wp-content/uploads/sites/2/2026/03/real-hero.jpg?quality=90&w=2400';
    const row = {
      ...newsRow({
        body: {
          assets: [
            { url: avatar, r2_url: '/r/blog/a1b2c3.jpg', kind: 'image', role: 'inline' },
            { url: hero, r2_url: '/r/blog/hero.jpg', kind: 'image', role: 'inline' },
          ],
        },
        body_markdown_zh:
          '正文\n\n![作者头像](/r/blog/a1b2c3.jpg)\n\n![正常题图](/r/blog/hero.jpg)',
      }),
      media: JSON.stringify([
        { type: 'image', url: avatar },
        { type: 'image', url: hero },
      ]),
    };

    const item = renderItem('news', row, 1, API);
    expect(item.media.map((asset) => asset.url)).not.toContain(avatar);
    expect(item.media.some((asset) => asset.url.includes('a1b2c3.jpg'))).toBe(false);
    expect(item.media.map((asset) => asset.url)).toContain(hero);
  });

  test('静态日报质量门也能识别头像的 R2 哈希别名并回退到正常 hero', () => {
    const avatar =
      'https://platform.theverge.com/wp-content/uploads/sites/2/chorus/author_profile_images/195810/EMMA_ROTH.0.jpg?quality=90&w=2400';
    const row = newsRow({
      cover_image: '/r/blog/a1b2c3.jpg',
      body: {
        assets: [
          {
            url: avatar,
            r2_url: '/r/blog/a1b2c3.jpg',
            kind: 'image',
            role: 'inline',
            width: 800,
            height: 800,
          },
          {
            url: 'https://platform.theverge.com/wp-content/uploads/sites/2/2026/03/real-hero.jpg?w=2400',
            r2_url: '/r/blog/real-hero.jpg',
            kind: 'image',
            role: 'inline',
            width: 1600,
            height: 900,
          },
        ],
      },
    });

    const item = renderItem('news', row, 1, API, { newsCoverQualityGate: true });
    expect(item.cover).toBe(`${API}/r/blog/real-hero.jpg`);
  });

  test('存量清理删除 body 映射后，持久 blocked URL 仍能拦 items.media 的绝对 R2 地址', () => {
    const row = {
      ...newsRow({
        editorial_image_blocked_urls: ['/r/blog/a1b2c3.jpg'],
        body: {
          assets: [
            {
              url: 'https://platform.theverge.com/wp-content/uploads/sites/2/2026/03/real-hero.jpg?w=2400',
              r2_url: '/r/blog/real-hero.jpg',
              kind: 'image',
              role: 'inline',
            },
          ],
        },
      }),
      media: JSON.stringify([
        { type: 'image', url: `${API}/r/blog/a1b2c3.jpg` },
        { type: 'image', url: `${API}/r/blog/real-hero.jpg` },
      ]),
    };

    const item = renderItem('news', row, 1, API);
    expect(item.media.some((asset) => asset.url.includes('a1b2c3.jpg'))).toBe(false);
    expect(item.media.some((asset) => asset.url.includes('real-hero.jpg'))).toBe(true);
  });

  test('正文 Markdown 回退同样归一绝对 R2 alias，不进入 cover 或 media', () => {
    const row = newsRow({
      editorial_image_blocked_urls: ['/r/blog/a1b2c3.jpg'],
      body_markdown_zh: [
        `![作者头像](${API}/r/blog/a1b2c3.jpg)`,
        '![正常题图](/r/blog/real-hero.jpg)',
      ].join('\n\n'),
    });

    const normal = renderItem('news', row, 1, API);
    expect(normal.media.some((asset) => asset.url.includes('a1b2c3.jpg'))).toBe(false);
    expect(normal.media.some((asset) => asset.url.includes('real-hero.jpg'))).toBe(true);

    const gated = renderItem('news', row, 1, API, { newsCoverQualityGate: true });
    expect(gated.cover).toBe(`${API}/r/blog/real-hero.jpg`);
  });
});

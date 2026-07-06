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
});

import { describe, test, expect } from 'vitest';
import { buildBlogPageMetaPatch } from './extract';

// Fix 1：og:image 采用从 page-scrape 专属放开到全部 blog 源。
// buildBlogPageMetaPatch 是抽出的纯决策函数(哪些 strategy 采用 cover / title / date)。
describe('buildBlogPageMetaPatch — og:image 采用条件', () => {
  test('meta 为 undefined → 无任何 patch', () => {
    const { sets, binds } = buildBlogPageMetaPatch('native', undefined);
    expect(sets).toEqual([]);
    expect(binds).toEqual([]);
  });

  test('native 策略 + meta.cover → 采用封面(Fix 1 主修)', () => {
    const { sets, binds } = buildBlogPageMetaPatch('native', {
      cover: 'https://cdn/hero.jpg',
    });
    // 有一条 cover_image 的 json_set
    expect(sets.length).toBe(1);
    expect(sets[0]).toContain('cover_image');
    expect(binds).toEqual(['https://cdn/hero.jpg']);
  });

  test('封面采用用 COALESCE(幂等,已有合格 cover 不覆盖)', () => {
    const { sets } = buildBlogPageMetaPatch('native', { cover: 'https://cdn/hero.jpg' });
    expect(sets[0]).toContain('COALESCE');
    // 空串也视为无封面(NULLIF)→ 允许 og:image 补
    expect(sets[0]).toContain('NULLIF');
  });

  test('native 策略下 title/published_at 不采用(RSS 标题权威)', () => {
    const { sets } = buildBlogPageMetaPatch('native', {
      title: '真标题',
      published_at: '2026-07-01T00:00:00Z',
    });
    // native 无 cover → 无任何 patch(title/date 只对 page-scrape 生效)
    expect(sets).toEqual([]);
  });

  test('page-scrape 策略 + cover/title/date 全采用', () => {
    const { sets, binds } = buildBlogPageMetaPatch('page-scrape', {
      cover: 'https://cdn/hero.jpg',
      title: '真标题',
      published_at: '2026-07-01T00:00:00Z',
    });
    expect(sets.length).toBe(3);
    expect(sets.some((s) => s.includes('cover_image'))).toBe(true);
    expect(sets.some((s) => s.startsWith('title'))).toBe(true);
    expect(sets.some((s) => s.includes('published_at'))).toBe(true);
    // title 截断到 300
    expect(binds).toContain('真标题');
  });

  test('page-scrape 策略 + 只有 title → 只更 title', () => {
    const { sets, binds } = buildBlogPageMetaPatch('page-scrape', { title: 'T' });
    expect(sets.length).toBe(1);
    expect(sets[0]).toMatch(/^title/);
    expect(binds).toEqual(['T']);
  });

  test('native 策略 + cover + title → 只采用 cover(title 丢弃)', () => {
    const { sets, binds } = buildBlogPageMetaPatch('native', {
      cover: 'https://cdn/hero.jpg',
      title: '不该采用',
    });
    expect(sets.length).toBe(1);
    expect(sets[0]).toContain('cover_image');
    expect(binds).toEqual(['https://cdn/hero.jpg']);
  });

  test('title 超长截断到 300', () => {
    const long = 'x'.repeat(500);
    const { binds } = buildBlogPageMetaPatch('page-scrape', { title: long });
    expect((binds[0] as string).length).toBe(300);
  });
});

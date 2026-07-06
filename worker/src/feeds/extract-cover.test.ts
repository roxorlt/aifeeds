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

// ═══════════════ Fix B（审查修复）：workflow 重跑不回写 og 外链 ═══════════════
// 忠实解释 buildBlogPageMetaPatch 生成的 cover 子句，锁 SQL 真的带迁移 marker 守卫：
// 迁移 marker(blog_media_r2_at)已置位时，cover='' 空槽**不得**被 og 外链回写。
function evalCoverPatch(
  coverSql: string,
  bind: string,
  extra: { cover_image?: string; blog_media_r2_at?: string },
): string | null {
  // COALESCE(NULLIF(cover,''), CASE WHEN marker IS NULL THEN ? END, cover)
  const cover = extra.cover_image;
  const guarded = /blog_media_r2_at/.test(coverSql); // 修复后 SQL 带 marker 守卫
  const nullif = cover === '' || cover == null ? null : cover;
  if (nullif != null) return nullif; // 已有合格 cover 不覆盖
  if (guarded) {
    const markerIsNull = extra.blog_media_r2_at == null;
    return markerIsNull ? bind : cover ?? null; // marker 置位 → 保留原值(不落外链)
  }
  return bind; // 旧逻辑(无守卫)：cover 空 → 无条件写 og 外链
}

describe('buildBlogPageMetaPatch — Fix B 迁移 marker 守卫', () => {
  test('生成的 cover 子句包含 blog_media_r2_at 守卫', () => {
    const { sets } = buildBlogPageMetaPatch('native', { cover: 'https://cdn/og.jpg' });
    expect(sets[0]).toContain('blog_media_r2_at');
    // 仍保留幂等 COALESCE/NULLIF（已有合格 cover 不覆盖）
    expect(sets[0]).toContain('COALESCE');
    expect(sets[0]).toContain('NULLIF');
  });

  test('marker 已置位 + cover=\'\' + 重跑 patch → cover 不落外链', () => {
    const { sets, binds } = buildBlogPageMetaPatch('native', { cover: 'https://cdn/og.jpg' });
    const result = evalCoverPatch(sets[0], binds[0] as string, {
      cover_image: '',
      blog_media_r2_at: '2026-07-06T00:00:00Z',
    });
    expect(result).not.toBe('https://cdn/og.jpg'); // 外链未回写
    expect(result).toBe(''); // 保留空槽 → 前端 monogram 兜底
  });

  test('marker 未置位(首轮)+ cover=\'\' → og 外链正常落位(随后 step4 迁 R2)', () => {
    const { sets, binds } = buildBlogPageMetaPatch('native', { cover: 'https://cdn/og.jpg' });
    const result = evalCoverPatch(sets[0], binds[0] as string, { cover_image: '' });
    expect(result).toBe('https://cdn/og.jpg');
  });

  test('已有合格 cover(/r/) → 不覆盖(marker 有无都不动)', () => {
    const { sets, binds } = buildBlogPageMetaPatch('native', { cover: 'https://cdn/og.jpg' });
    const result = evalCoverPatch(sets[0], binds[0] as string, {
      cover_image: '/r/blog/good.jpg',
      blog_media_r2_at: '2026-07-06T00:00:00Z',
    });
    expect(result).toBe('/r/blog/good.jpg');
  });
});

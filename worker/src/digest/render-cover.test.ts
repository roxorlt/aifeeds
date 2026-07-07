import { describe, test, expect } from 'vitest';
import { renderItem, type RenderRow } from './render';

const API = 'https://api.ai-feeds.com';

// 构造一条 news(blog)行,extra 为传入对象。
function newsRow(extra: Record<string, unknown>, over: Partial<RenderRow> = {}): RenderRow {
  return {
    id: 'blog:test:deadbeef',
    title: '标题',
    content: '',
    content_translated: null,
    author: null,
    handle: null,
    url: 'https://example.com/post',
    media: null,
    extra: JSON.stringify(extra),
    ...over,
  };
}

const GATE = { newsCoverQualityGate: true } as const;

describe('pickCover news — 渲染层质量门(newsCoverQualityGate)', () => {
  test('外链形态 cover_image 视为无效,进入回退链', () => {
    const row = newsRow({
      cover_image: 'https://external.cdn/cover.jpg',
      body: { assets: [{ url: 'https://external.cdn/hero.jpg', r2_url: '/r/blog/good.jpg', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    // 不采用外链 cover_image,回退到 R2 正文图
    expect(item.cover).toBe(`${API}/r/blog/good.jpg`);
  });

  test('回退只用 asset.r2_url,绝不用原始外链 asset.url', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://external.cdn/hero.jpg', r2_url: '/r/blog/good.jpg', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBe(`${API}/r/blog/good.jpg`);
    expect(item.cover).not.toContain('external.cdn');
  });

  test('无 r2_url 的纯外链正文图不当封面 → cover=null', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://external.cdn/hero.jpg', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('body_markdown 里的外链 inline 图不当封面 → cover=null(症状1 挂图)', () => {
    const row = newsRow({
      body: { assets: [] },
      body_markdown: '<img src="https://image.jiqizhixin.com/uploads/article/cover_image/doubao.jpg" referrerpolicy="no-referrer">',
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('二维码 URL 被黑名单拒(症状3 qbitai 二维码),命中原始 url', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://www.qbitai.com/wp-content/uploads/2019/01/qrcode_QbitAI_1.jpg', r2_url: '/r/blog/8fba86c7cbff.jpg', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('黑名单拒二维码后,继续取下一张合格的 R2 正文图', () => {
    const row = newsRow({
      body: {
        assets: [
          { url: 'https://www.qbitai.com/qrcode_QbitAI_1.jpg', r2_url: '/r/blog/qr.jpg', kind: 'image', role: 'inline' },
          { url: 'https://www.qbitai.com/real-hero.jpg', r2_url: '/r/blog/hero.jpg', kind: 'image', role: 'inline' },
        ],
      },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBe(`${API}/r/blog/hero.jpg`);
  });

  test('logo/avatar 被黑名单拒(命中 r2 key)', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://cdn/x.png', r2_url: '/r/blog/site-logo.png', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('尺寸不合格拒:maxDim < 240', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://cdn/x.png', r2_url: '/r/blog/small.png', kind: 'image', role: 'inline', width: 100, height: 100 }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('尺寸不合格拒:宽高比越界(ar > 2)', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://cdn/x.png', r2_url: '/r/blog/wide.png', kind: 'image', role: 'inline', width: 1200, height: 200 }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('尺寸合格放行:maxDim≥240 且 0.5≤ar≤2', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://cdn/x.png', r2_url: '/r/blog/ok.png', kind: 'image', role: 'inline', width: 800, height: 600 }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBe(`${API}/r/blog/ok.png`);
  });

  test('全部不过 → cover=null', () => {
    const row = newsRow({
      cover_image: 'https://external.cdn/cover.jpg',
      body: { assets: [{ url: 'https://external.cdn/hero.jpg', kind: 'image', role: 'inline' }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('R2 形态 cover_image(相对 /r/)直接采用', () => {
    const row = newsRow({ cover_image: '/r/blog/cover-r2.jpg' });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBe(`${API}/r/blog/cover-r2.jpg`);
  });

  test('R2 形态 cover_image(api 域绝对形式)直接采用', () => {
    const row = newsRow({ cover_image: `${API}/r/blog/cover-abs.jpg` });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBe(`${API}/r/blog/cover-abs.jpg`);
  });

  // ── Fix 2(2026-07-07):NO_COVER_SOURCES 渲染层纵深短路 ──
  // jiqizhixin 是源级 no-cover 名单成员;即便数据里同时有 R2 cover_image 和 R2 正文图,
  // daily 渲染(gated 路径)也必须直接返回 null,让名单成为任何数据形态下的硬约束。
  test('jiqizhixin(no-cover 源)即便有 R2 cover_image + 正文图 → daily 渲染 cover=null', () => {
    const row = newsRow({
      feed_key: 'jiqizhixin',
      cover_image: '/r/blog/jqzx-cover.jpg', // R2 形态,平时会直采
      body: { assets: [{ url: 'https://external.cdn/hero.jpg', r2_url: '/r/blog/jqzx-hero.jpg', kind: 'image', role: 'inline', width: 800, height: 600 }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('jiqizhixin 短路优先级高于 R2 cover_image 直采', () => {
    const row = newsRow({ feed_key: 'jiqizhixin', cover_image: '/r/blog/cover-r2.jpg' });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBeNull();
  });

  test('qbitai(非 no-cover 源)正常走质量门,合格 R2 正文图照采', () => {
    const row = newsRow({
      feed_key: 'qbitai',
      body: { assets: [{ url: 'https://www.qbitai.com/real-hero.jpg', r2_url: '/r/blog/hero.jpg', kind: 'image', role: 'inline', width: 800, height: 600 }] },
    });
    const item = renderItem('news', row, 1, API, GATE);
    expect(item.cover).toBe(`${API}/r/blog/hero.jpg`);
  });

  // 隔离锁:no-cover 短路只在 gated(daily)路径生效;默认路径(codex/daily-api)不感知名单,逐字节不变。
  test('隔离:jiqizhixin 默认路径(无 flag)仍直采 R2 cover_image(不短路)', () => {
    const row = newsRow({ feed_key: 'jiqizhixin', cover_image: '/r/blog/cover-r2.jpg' });
    const legacy = renderItem('news', row, 1, API);
    expect(legacy.cover).toBe(`${API}/r/blog/cover-r2.jpg`);
  });

  // ── 隔离回归:不传门控 flag(daily-api / codex-push 路径)行为逐字节不变 ──
  test('默认(无 flag)外链 cover_image 仍直采(codex/JSON 路径不受影响)', () => {
    const row = newsRow({ cover_image: 'https://external.cdn/cover.jpg' });
    const legacy = renderItem('news', row, 1, API);
    expect(legacy.cover).toBe('https://external.cdn/cover.jpg');
  });

  test('默认(无 flag)外链正文图仍回退当封面(旧行为保留)', () => {
    const row = newsRow({
      body: { assets: [{ url: 'https://external.cdn/hero.jpg', kind: 'image', role: 'inline' }] },
    });
    const legacy = renderItem('news', row, 1, API);
    expect(legacy.cover).toBe('https://external.cdn/hero.jpg');
  });
});

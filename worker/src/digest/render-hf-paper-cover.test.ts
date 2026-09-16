import { describe, expect, test } from 'vitest';
import { renderItem, type RenderRow } from './render';

const API = 'https://api.ai-feeds.com';

function paperRow(media: unknown, extra: Record<string, unknown> = {}): RenderRow {
  return {
    id: 'hf_paper:2609.11412',
    title: 'X-AuT',
    content: 'abstract',
    content_translated: '摘要',
    author: null,
    handle: null,
    url: 'https://huggingface.co/papers/2609.11412',
    media: media === null ? null : JSON.stringify(media),
    extra: JSON.stringify(extra),
  };
}

// 出片机在大陆,cdn-thumbnails.huggingface.co / arxiv.org 要么连不上要么一张 10s+,
// 所以论文条目宁可无图也不给外链。
describe('renderItem hf-paper — 封面与 media 只认站内 R2', () => {
  test('media 全是外链但 figure_image 已迁 R2 → cover 用 figure', () => {
    const row = paperRow(
      [{ type: 'image', url: 'https://cdn-thumbnails.huggingface.co/social-thumbnails/x.png' }],
      { figure_image: { source: 'arxiv-html', r2_url: '/r/hf/abc.png', raw_url: 'https://arxiv.org/html/v1/f1.png' } },
    );
    const item = renderItem('hf-paper', row, 1, API);
    expect(item.cover).toBe(`${API}/r/hf/abc.png`);
    expect(item.media).toEqual([{ type: 'image', url: `${API}/r/hf/abc.png` }]);
  });

  test('media 与 figure 全是外链 → cover=null 且 media 为空(raw_url 回退已删)', () => {
    const row = paperRow(
      [{ type: 'image', url: 'https://cdn-thumbnails.huggingface.co/social-thumbnails/x.png' }],
      { figure_image: { source: 'none', raw_url: 'https://arxiv.org/html/v1/f1.png' } },
    );
    const item = renderItem('hf-paper', row, 1, API);
    expect(item.cover).toBeNull();
    expect(item.media).toEqual([]);
  });

  test('media 已迁 R2 → 原样取 media[0],figure 同图不重复', () => {
    const row = paperRow(
      [
        { type: 'image', url: '/r/hf/figure.png', role: 'figure' },
        { type: 'image', url: '/r/hf/thumb.jpg', role: 'thumbnail_fallback' },
      ],
      { figure_image: { source: 'arxiv-html', r2_url: '/r/hf/figure.png' } },
    );
    const item = renderItem('hf-paper', row, 1, API);
    expect(item.cover).toBe(`${API}/r/hf/figure.png`);
    expect(item.media).toEqual([
      { type: 'image', url: `${API}/r/hf/figure.png` },
      { type: 'image', url: `${API}/r/hf/thumb.jpg` },
    ]);
  });

  test('media[0] 是外链、media[1] 已迁 R2 → 跳过外链取站内那张', () => {
    const row = paperRow([
      { type: 'image', url: 'https://cdn-thumbnails.huggingface.co/x.png' },
      { type: 'image', url: '/r/hf/real.png' },
    ]);
    const item = renderItem('hf-paper', row, 1, API);
    expect(item.cover).toBe(`${API}/r/hf/real.png`);
    expect(item.media).toEqual([{ type: 'image', url: `${API}/r/hf/real.png` }]);
  });

  test('api 域绝对形式的 /r/ 也算站内;第三方域名里的 /r/ 不算', () => {
    const ok = renderItem('hf-paper', paperRow([{ type: 'image', url: `${API}/r/hf/abs.png` }]), 1, API);
    expect(ok.cover).toBe(`${API}/r/hf/abs.png`);
    const bad = renderItem('hf-paper', paperRow([{ type: 'image', url: 'https://evil.example.com/r/hf/abs.png' }]), 1, API);
    expect(bad.cover).toBeNull();
    expect(bad.media).toEqual([]);
  });

  test('完全没有 media 与 figure_image → cover=null,media 为空', () => {
    const item = renderItem('hf-paper', paperRow(null), 1, API);
    expect(item.cover).toBeNull();
    expect(item.media).toEqual([]);
  });
});

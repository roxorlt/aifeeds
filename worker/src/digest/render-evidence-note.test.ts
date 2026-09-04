import { describe, expect, test } from 'vitest';

// 补录线索的正文补充（2026-09-04）：extra.manual_evidence_text 映射成 payload 的
// evidence_note，供口播当补充素材。summary / summary_full 的取值一字不动 —— 卡片与静态页
// 显示的仍是 owner 自己写的那句话。

import { renderItem, type RenderRow } from './render';

const API = 'https://api.ai-feeds.com';

function mkRow(over: Partial<RenderRow> & { id: string }): RenderRow {
  return {
    title: null, content: null, content_translated: null, author: null,
    handle: null, url: null, media: null, extra: null,
    ...over,
  };
}

const MANUAL_EXTRA = {
  title_zh: 'OpenAI发布Astra',
  ai_summary_zh: 'OpenAI发布Astra',
  source_company: '手工补录',
  event_fingerprint: 'mnoa1:abc',
  manual_lead: { lead_id: 'ml-20260904-abc123def456', evidence_ids: [] },
};

describe('renderItem evidence_note', () => {
  test('有补充素材时映射进 evidence_note', () => {
    const item = renderItem('news', mkRow({
      id: 'blog:manual:ml-20260904-abc123def456',
      extra: JSON.stringify({ ...MANUAL_EXTRA, manual_evidence_text: 'OpenAI 今天发布 Astra。面向企业开放。' }),
    }), 1, API);

    expect(item.evidence_note).toBe('OpenAI 今天发布 Astra。面向企业开放。');
  });

  test('没有补充素材时省略字段,payload 逐字节不变', () => {
    const item = renderItem('news', mkRow({
      id: 'blog:manual:ml-20260904-abc123def456',
      extra: JSON.stringify(MANUAL_EXTRA),
    }), 1, API);

    expect(item.evidence_note).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(item, 'evidence_note')).toBe(false);
  });

  test('补充素材不改 summary / summary_full —— 显示的仍是 owner 的那句话', () => {
    const row = mkRow({
      id: 'blog:manual:ml-20260904-abc123def456',
      extra: JSON.stringify({ ...MANUAL_EXTRA, manual_evidence_text: '完全不同的一段背景素材。' }),
    });
    const bare = renderItem('news', mkRow({
      id: 'blog:manual:ml-20260904-abc123def456', extra: JSON.stringify(MANUAL_EXTRA),
    }), 1, API);
    const enriched = renderItem('news', row, 1, API);

    expect(enriched.summary).toBe(bare.summary);
    expect(enriched.summary_full).toBe(bare.summary_full);
    expect(enriched.title).toBe(bare.title);
    expect(enriched.summary).toBe('OpenAI发布Astra');
  });

  test('素材是空白时省略字段', () => {
    const item = renderItem('news', mkRow({
      id: 'blog:manual:ml-20260904-abc123def456',
      extra: JSON.stringify({ ...MANUAL_EXTRA, manual_evidence_text: '   ' }),
    }), 1, API);
    expect(item.evidence_note).toBeUndefined();
  });

  test('素材不是字符串时省略字段,不把脏值推给口播', () => {
    const item = renderItem('news', mkRow({
      id: 'blog:manual:ml-20260904-abc123def456',
      extra: JSON.stringify({ ...MANUAL_EXTRA, manual_evidence_text: { background: 'x' } }),
    }), 1, API);
    expect(item.evidence_note).toBeUndefined();
  });

  test('非 news 源不产出 evidence_note', () => {
    const item = renderItem('x', mkRow({
      id: 'x_list:1', content_translated: '推文译文。',
      extra: JSON.stringify({ manual_evidence_text: '不该出现在这里的素材。' }),
    }), 1, API);
    expect(item.evidence_note).toBeUndefined();
  });
});

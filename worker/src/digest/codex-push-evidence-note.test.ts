import { describe, expect, test } from 'vitest';

// 补录线索的补充素材要一路透传到 codex payload:口播模型在面板侧读的就是这个字段。

import { toCodexItem } from './codex-push';
import type { RenderedItem } from './render';

function rendered(over: Partial<RenderedItem> = {}): RenderedItem {
  return {
    rank: 1,
    item_id: 'blog:manual:ml-20260904-abc123def456',
    source: 'news',
    title: 'OpenAI发布Astra',
    summary: 'OpenAI发布Astra',
    summary_full: 'OpenAI发布Astra',
    url: '',
    deep_link: '/i/blog:manual:ml-20260904-abc123def456',
    author: '手工补录',
    cover: null,
    logo: null,
    media: [],
    ...over,
  };
}

describe('toCodexItem evidence_note', () => {
  test('有补充素材时透传', () => {
    expect(toCodexItem(rendered({ evidence_note: 'OpenAI 今天发布 Astra。面向企业开放。' })))
      .toMatchObject({ evidence_note: 'OpenAI 今天发布 Astra。面向企业开放。' });
  });

  test('没有补充素材时省略字段,payload 逐字节不变', () => {
    const item = toCodexItem(rendered());
    expect(Object.prototype.hasOwnProperty.call(item, 'evidence_note')).toBe(false);
  });

  test('素材是空串时同样省略', () => {
    const item = toCodexItem(rendered({ evidence_note: '' }));
    expect(Object.prototype.hasOwnProperty.call(item, 'evidence_note')).toBe(false);
  });
});

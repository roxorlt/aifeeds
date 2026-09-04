import { describe, expect, test, vi } from 'vitest';

import {
  MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS,
  clampEnrichmentText,
  collectManualLeadEnrichment,
  manualLeadNeedsEnrichment,
  type ManualLeadEnrichmentAdapters,
} from './manual-lead-enrichment';

function adapters(overrides: Partial<ManualLeadEnrichmentAdapters> = {}): ManualLeadEnrichmentAdapters {
  return {
    fetchPlainText: vi.fn(async () => null),
    compress: vi.fn(async () => null),
    ...overrides,
  };
}

describe('manualLeadNeedsEnrichment', () => {
  test('零证据线索要补充素材', () => {
    expect(manualLeadNeedsEnrichment({ evidence: [] })).toBe(true);
  });

  test('已有签名证据的线索不触发 —— 它的摘要本来就是核验过的正文', () => {
    expect(manualLeadNeedsEnrichment({ evidence: [{ id: 'ev-1' }] })).toBe(false);
  });

  test('证据字段缺失当作零证据', () => {
    expect(manualLeadNeedsEnrichment({})).toBe(true);
  });
});

describe('clampEnrichmentText', () => {
  test('按 code point 截断,不切碎代理对', () => {
    const emoji = '🙂'.repeat(MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS + 10);
    const clamped = clampEnrichmentText(emoji);
    expect([...clamped]).toHaveLength(MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS);
    expect(clamped.endsWith('🙂')).toBe(true);
  });

  test('压掉多余空白', () => {
    expect(clampEnrichmentText('  背景 一\n\n背景  二 ')).toBe('背景 一 背景 二');
  });

  test('空白输入回空串', () => {
    expect(clampEnrichmentText('   \n ')).toBe('');
  });
});

describe('collectManualLeadEnrichment', () => {
  test('有链接时按链接抓正文,压缩后带上来源', async () => {
    const fetchPlainText = vi.fn(async () => ({
      text: 'TechCrunch 报道了这件事的全部经过。',
      url: 'https://techcrunch.com/2026/09/04/a/',
      publisher: 'TechCrunch',
      kind: 'document' as const,
    }));
    const compress = vi.fn(async () => '背景一。背景二。');
    const result = await collectManualLeadEnrichment(
      { url: 'https://techcrunch.com/2026/09/04/a/', text: 'owner 的陈述' },
      adapters({ fetchPlainText, compress }),
      { now: 1_757_000_000_000 },
    );

    expect(fetchPlainText).toHaveBeenCalledWith({ url: 'https://techcrunch.com/2026/09/04/a/' });
    expect(result).toEqual({
      text: '背景一。背景二。',
      source: {
        url: 'https://techcrunch.com/2026/09/04/a/',
        publisher: 'TechCrunch',
        fetched_at: new Date(1_757_000_000_000).toISOString(),
        kind: 'document',
      },
    });
  });

  test('没有链接时用文字线索走搜索', async () => {
    const fetchPlainText = vi.fn(async () => ({
      text: '搜到的正文', url: 'https://example.com/x', publisher: 'Example', kind: 'search+document' as const,
    }));
    const compress = vi.fn(async () => '搜索背景。');
    const result = await collectManualLeadEnrichment(
      { url: null, text: 'OpenAI 发布 GPT-6' },
      adapters({ fetchPlainText, compress }),
      { now: 0 },
    );

    expect(fetchPlainText).toHaveBeenCalledWith({ query: 'OpenAI 发布 GPT-6' });
    expect(result?.source.kind).toBe('search+document');
  });

  test('抓取失败(抛异常)时回 null,不把异常抛给调用方', async () => {
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({ fetchPlainText: vi.fn(async () => { throw new Error('gateway_502'); }) }),
      { now: 0 },
    );
    expect(result).toBeNull();
  });

  test('抓不到素材时不调用模型', async () => {
    const compress = vi.fn(async () => '不该被调用');
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({ fetchPlainText: vi.fn(async () => null), compress }),
      { now: 0 },
    );
    expect(result).toBeNull();
    expect(compress).not.toHaveBeenCalled();
  });

  test('网关回了空正文时也不调用模型', async () => {
    const compress = vi.fn(async () => '不该被调用');
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({
        fetchPlainText: vi.fn(async () => ({
          text: '  \n ', url: 'https://example.com/a', publisher: 'Example', kind: 'document' as const,
        })),
        compress,
      }),
      { now: 0 },
    );
    expect(result).toBeNull();
    expect(compress).not.toHaveBeenCalled();
  });

  test('模型压缩失败时回 null —— 宁可什么都不写', async () => {
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({
        fetchPlainText: vi.fn(async () => ({
          text: '正文', url: 'https://example.com/a', publisher: 'Example', kind: 'document' as const,
        })),
        compress: vi.fn(async () => { throw new Error('deepseek_down'); }),
      }),
      { now: 0 },
    );
    expect(result).toBeNull();
  });

  test('模型回空白时回 null', async () => {
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({
        fetchPlainText: vi.fn(async () => ({
          text: '正文', url: 'https://example.com/a', publisher: 'Example', kind: 'document' as const,
        })),
        compress: vi.fn(async () => '   '),
      }),
      { now: 0 },
    );
    expect(result).toBeNull();
  });

  test('模型话太多时按 400 code point 截断', async () => {
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({
        fetchPlainText: vi.fn(async () => ({
          text: '正文', url: 'https://example.com/a', publisher: 'Example', kind: 'document' as const,
        })),
        compress: vi.fn(async () => '背'.repeat(1_000)),
      }),
      { now: 0 },
    );
    expect([...(result?.text || '')]).toHaveLength(MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS);
  });

  test('超出总预算时放弃,不吊死在慢网关上', async () => {
    vi.useFakeTimers();
    try {
      const pending = collectManualLeadEnrichment(
        { url: 'https://example.com/a', text: 'x' },
        adapters({ fetchPlainText: vi.fn(() => new Promise<null>(() => {})) }),
        { now: 0, budgetMs: 60_000 },
      );
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('线索既没链接也没文字时什么都不做', async () => {
    const fetchPlainText = vi.fn(async () => null);
    const result = await collectManualLeadEnrichment(
      { url: null, text: '   ' },
      adapters({ fetchPlainText }),
      { now: 0 },
    );
    expect(result).toBeNull();
    expect(fetchPlainText).not.toHaveBeenCalled();
  });

  test('素材里的来源缺失时退回线索链接与占位发布方', async () => {
    const result = await collectManualLeadEnrichment(
      { url: 'https://example.com/a', text: 'x' },
      adapters({
        fetchPlainText: vi.fn(async () => ({
          text: '正文', url: '', publisher: '', kind: 'document' as const,
        })),
        compress: vi.fn(async () => '背景。'),
      }),
      { now: 0 },
    );
    expect(result?.source).toMatchObject({ url: 'https://example.com/a', publisher: '未知来源' });
  });
});

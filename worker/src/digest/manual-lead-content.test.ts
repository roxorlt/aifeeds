import { describe, expect, test, vi } from 'vitest';

import {
  MANUAL_LEAD_CONTENT_EXCERPT_MAX_CHARS,
  classifyManualLeadMaterial,
  manualLeadContentExcerpt,
  manualLeadMaterialPrefix,
  orderManualLeadMaterials,
  runManualLeadContentPipeline,
  type ManualLeadContentAdapters,
  type ManualLeadContentStage,
} from './manual-lead-content';
import type { ManualEnrichmentMaterial } from './manual-lead-enrichment';

function material(over: Partial<ManualEnrichmentMaterial> = {}): ManualEnrichmentMaterial {
  return {
    text: '正文。', url: 'https://techcrunch.com/a', publisher: 'techcrunch.com',
    kind: 'document', ...over,
  };
}

describe('素材分档（规格第 2 节）', () => {
  test('非推特链接算公开报道，不加任何出处前缀', () => {
    const classified = classifyManualLeadMaterial(material());
    expect(classified.tier).toBe('report');
    expect(manualLeadMaterialPrefix(classified)).toBe('');
  });

  test('白名单里的官方 X 账号算第一方公告，前缀写明是哪家的官方账号', () => {
    const classified = classifyManualLeadMaterial(material({
      url: 'https://x.com/OpenAI/status/1234567890', publisher: 'X @OpenAI', kind: 'tweet',
    }));
    expect(classified).toMatchObject({ tier: 'official_x', actor: 'OpenAI', handle: 'OpenAI' });
    expect(manualLeadMaterialPrefix(classified)).toBe('以下内容为 OpenAI 官方账号的公告：');
  });

  test('白名单大小写不敏感：handle 是 openai 与 OpenAI 同档', () => {
    expect(classifyManualLeadMaterial(material({
      url: 'https://twitter.com/openai/status/1', kind: 'tweet',
    })).tier).toBe('official_x');
  });

  test('其余 X 用户不算公开报道，前缀写明是博主发文', () => {
    const classified = classifyManualLeadMaterial(material({
      url: 'https://x.com/some_reporter/status/99', publisher: 'X @some_reporter', kind: 'tweet',
    }));
    expect(classified).toMatchObject({ tier: 'tweet', handle: 'some_reporter', actor: '' });
    expect(manualLeadMaterialPrefix(classified))
      .toBe('以下内容为 X 博主 @some_reporter 的发文，非媒体报道：');
  });

  test('看不出是哪个 handle 的 x.com 链接按最保守的一档处理', () => {
    const classified = classifyManualLeadMaterial(material({
      url: 'https://x.com/i/web/status/1', kind: 'tweet',
    }));
    expect(classified.tier).toBe('tweet');
    expect(manualLeadMaterialPrefix(classified))
      .toBe('以下内容为 X 博主的发文，非媒体报道：');
  });
});

describe('素材排序：有 A/B 档就绝不拿 C 档当主料', () => {
  const report = classifyManualLeadMaterial(material({ url: 'https://theverge.com/a' }));
  const official = classifyManualLeadMaterial(material({
    url: 'https://x.com/OpenAI/status/1', kind: 'tweet',
  }));
  const tweet = classifyManualLeadMaterial(material({
    url: 'https://x.com/blogger/status/2', kind: 'tweet',
  }));

  test('A > B > C', () => {
    expect(orderManualLeadMaterials([tweet, official, report]).map((item) => item.tier))
      .toEqual(['report', 'official_x', 'tweet']);
  });

  test('只有 C 档时它就是主料', () => {
    expect(orderManualLeadMaterials([tweet])[0].tier).toBe('tweet');
  });

  test('同档之间保持传入顺序：先抓到的链接正文排在搜索召回之前', () => {
    const first = classifyManualLeadMaterial(material({ url: 'https://a.example/1' }));
    const second = classifyManualLeadMaterial(material({ url: 'https://b.example/2' }));
    expect(orderManualLeadMaterials([first, second]).map((item) => item.url))
      .toEqual(['https://a.example/1', 'https://b.example/2']);
  });
});

describe('交给生成函数的素材正文', () => {
  test('逐份加出处前缀后拼起来，出处信息不进提示词', () => {
    const excerpt = manualLeadContentExcerpt([
      classifyManualLeadMaterial(material({ text: '媒体报道正文。' })),
      classifyManualLeadMaterial(material({
        text: '博主说的话。', url: 'https://x.com/blogger/status/2', kind: 'tweet',
      })),
    ]);
    expect(excerpt).toBe(
      '媒体报道正文。\n\n以下内容为 X 博主 @blogger 的发文，非媒体报道：\n博主说的话。',
    );
  });

  test('按既有口径截到 4000 字', () => {
    const excerpt = manualLeadContentExcerpt([
      classifyManualLeadMaterial(material({ text: '甲'.repeat(9_000) })),
    ]);
    expect(excerpt.length).toBe(MANUAL_LEAD_CONTENT_EXCERPT_MAX_CHARS);
    expect(MANUAL_LEAD_CONTENT_EXCERPT_MAX_CHARS).toBe(4_000);
  });

  test('一份素材都没有时是空串', () => {
    expect(manualLeadContentExcerpt([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 流水线本身。硬约束：**它永远不抛异常、永远返回一份结果** —— 调用方拿着结果去入池，
// 入池不能被取材或生成连坐（规格第 8 节第一条）。
// ---------------------------------------------------------------------------
const CLUE = {
  url: 'https://openai.com/index/astra/',
  text: 'OpenAI 发布了企业级模型 Astra',
  date: '2026-09-05',
};

function adapters(over: Partial<ManualLeadContentAdapters> = {}): ManualLeadContentAdapters {
  return {
    fetchSource: vi.fn(async () => material({
      text: 'OpenAI 今天发布 Astra，面向企业客户开放。',
      url: 'https://openai.com/index/astra/', publisher: 'openai.com',
    })),
    analyze: vi.fn(async () => ({ headline: 'OpenAI 发布 Astra', query: 'OpenAI Astra 企业模型' })),
    search: vi.fn(async () => material({
      text: '路透社报道：Astra 面向企业开放。',
      url: 'https://reuters.com/astra', publisher: 'reuters.com', kind: 'search+document',
    })),
    generate: vi.fn(async () => ({
      aiCategory: 'model-release' as const,
      titleZh: 'OpenAI 发布企业级模型 Astra',
      rawTitleZh: 'OpenAI 发布企业级模型 Astra',
      bodyZh: 'OpenAI 今日发布 Astra，面向企业客户开放，是该系列第一款产品。',
      aiSummaryZh: 'OpenAI 发布 Astra，把企业级推理能力做成可直接采购的产品。',
      rawGuests: undefined,
      grounding: { suspect: false, reason: '', bodySubjects: [], outputSubjects: [] },
    })),
    ...over,
  };
}

function stageRecorder() {
  const stages: ManualLeadContentStage[] = [];
  return { stages, onStage: async (stage: ManualLeadContentStage) => { stages.push(stage); } };
}

describe('runManualLeadContentPipeline', () => {
  test('有链接：抓正文 → 读懂并拟检索词 → 搜索 → 生成，阶段依次报出去', async () => {
    const deps = adapters();
    const recorder = stageRecorder();
    const result = await runManualLeadContentPipeline(CLUE, deps, recorder);

    expect(recorder.stages).toEqual(['fetching_source', 'analyzing', 'searching', 'drafting']);
    expect(deps.fetchSource).toHaveBeenCalledWith(CLUE.url, CLUE.date);
    expect(deps.search).toHaveBeenCalledWith('OpenAI Astra 企业模型', CLUE.date);
    expect(result.drafted).toEqual({
      title: 'OpenAI 发布企业级模型 Astra',
      summary: 'OpenAI 发布 Astra，把企业级推理能力做成可直接采购的产品。',
      source: 'openai.com',
      url: 'https://openai.com/index/astra/',
    });
    expect(result.materialTier).toBe('report');
    expect(result.aiCategory).toBe('model-release');
    // 生成出来的正文中译写进 extra.excerpt_zh，卡片图与小红书正文靠它变厚。
    expect(result.excerptZh).toBe('OpenAI 今日发布 Astra，面向企业客户开放，是该系列第一款产品。');
    expect(result.materialExcerpt).toContain('面向企业客户开放');
  });

  test('生成用的标题取抓回正文里的原标题，摘要素材含两份来源', async () => {
    const deps = adapters();
    await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(deps.generate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'OpenAI 发布 Astra',
      sourceCompany: 'openai.com',
      lang: 'zh',
      kind: 'blog',
    }));
    const excerpt = String(vi.mocked(deps.generate).mock.calls[0][0].excerpt);
    expect(excerpt).toContain('OpenAI 今天发布 Astra');
    expect(excerpt).toContain('路透社报道');
  });

  test('没有链接：owner 那句话直接当检索词，不走抓取也不走分析', async () => {
    const deps = adapters();
    const recorder = stageRecorder();
    const result = await runManualLeadContentPipeline(
      { url: null, text: CLUE.text, date: CLUE.date }, deps, recorder,
    );

    expect(recorder.stages).toEqual(['searching', 'drafting']);
    expect(deps.fetchSource).not.toHaveBeenCalled();
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(deps.search).toHaveBeenCalledWith(CLUE.text, CLUE.date);
    // 只有搜索素材时，生成用的标题退回 owner 那句话（规格第 3 节的传参约定）。
    expect(vi.mocked(deps.generate).mock.calls[0][0].title).toBe(CLUE.text);
    expect(result.drafted?.source).toBe('reuters.com');
  });

  test('取材抛异常照样走完，候选拿得到一份结果', async () => {
    const deps = adapters({
      fetchSource: vi.fn(async () => { throw new Error('gateway down'); }),
    });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    // 抓取那一路挂了，搜索仍然按 owner 那句话跑，生成照常。
    expect(deps.search).toHaveBeenCalledWith(CLUE.text, CLUE.date);
    expect(result.drafted).not.toBeNull();
    expect(result.materialTier).toBe('report');
  });

  test('分析抛异常时退回用 owner 那句话检索，不让这一步拖垮整轮', async () => {
    const deps = adapters({ analyze: vi.fn(async () => { throw new Error('llm down'); }) });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(deps.search).toHaveBeenCalledWith(CLUE.text, CLUE.date);
    expect(result.drafted).not.toBeNull();
  });

  test('生成抛异常时不起草，素材与分档照样带出去', async () => {
    const deps = adapters({ generate: vi.fn(async () => { throw new Error('llm down'); }) });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(result.drafted).toBeNull();
    expect(result.materialTier).toBe('report');
    expect(result.detail).toContain('生成');
  });

  test('搜索与抓取都没结果时素材分档是「什么都没取到」', async () => {
    const deps = adapters({
      fetchSource: vi.fn(async () => null),
      search: vi.fn(async () => null),
      generate: vi.fn(async () => { throw new Error('不该被调用'); }),
    });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(result.materialTier).toBe('none');
    expect(result.drafted).toBeNull();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(result.detail).toContain('素材');
  });

  test('只取到推文时分档是 C，主料就是那条推文', async () => {
    const deps = adapters({
      fetchSource: vi.fn(async () => material({
        text: '博主说 Astra 要来了。', url: 'https://x.com/blogger/status/7',
        publisher: 'X @blogger', kind: 'tweet',
      })),
      search: vi.fn(async () => null),
    });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(result.materialTier).toBe('tweet');
    expect(result.drafted?.url).toBe('https://x.com/blogger/status/7');
    expect(result.materialExcerpt).toContain('以下内容为 X 博主 @blogger 的发文，非媒体报道：');
  });

  test('推文与媒体报道都取到时，媒体报道当主料，推文只作补充', async () => {
    const deps = adapters({
      fetchSource: vi.fn(async () => material({
        text: '博主说 Astra 要来了。', url: 'https://x.com/blogger/status/7',
        publisher: 'X @blogger', kind: 'tweet',
      })),
    });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(result.materialTier).toBe('report');
    expect(result.drafted?.source).toBe('reuters.com');
    expect(result.materialExcerpt.indexOf('路透社'))
      .toBeLessThan(result.materialExcerpt.indexOf('以下内容为 X 博主'));
  });

  test('总预算到点就立刻回，不挂住调用方', async () => {
    const never = () => new Promise<never>(() => {});
    const deps = adapters({ fetchSource: vi.fn(never) });
    const started = Date.now();
    const result = await runManualLeadContentPipeline(
      CLUE, deps, stageRecorder(), { budgetMs: 30 },
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.drafted).toBeNull();
    expect(result.detail).toContain('超时');
    // 卡在哪一步要说得出来，卡片上不能只写一句「处理失败」。
    expect(result.stoppedAt).toBe('fetching_source');
  });

  test('单步预算到点只作废这一步，后面的步骤照跑', async () => {
    const never = () => new Promise<never>(() => {});
    const deps = adapters({ fetchSource: vi.fn(never) });
    const result = await runManualLeadContentPipeline(
      CLUE, deps, stageRecorder(), { stageBudgetMs: { fetching_source: 20 } },
    );
    expect(deps.search).toHaveBeenCalled();
    expect(result.drafted).not.toBeNull();
  });

  test('阶段回调自己抛异常也伤不到整轮', async () => {
    const result = await runManualLeadContentPipeline(CLUE, adapters(), {
      onStage: async () => { throw new Error('D1 写不进去'); },
    });
    expect(result.drafted).not.toBeNull();
  });

  test('起草结果不合规时当没起草：入池宁可退回那句话，也不能被拒签', async () => {
    const deps = adapters({
      generate: vi.fn(async () => ({
        aiCategory: 'other' as const,
        titleZh: '短', // 短于签名快照要求的 6 个 code point
        rawTitleZh: '短',
        bodyZh: '',
        aiSummaryZh: '正常长度的一句话摘要，够写进候选。',
        rawGuests: undefined,
        grounding: { suspect: false, reason: '', bodySubjects: [], outputSubjects: [] },
      })),
    });
    const result = await runManualLeadContentPipeline(CLUE, deps, stageRecorder());
    expect(result.drafted).toBeNull();
    expect(result.detail).toContain('起草');
  });
});

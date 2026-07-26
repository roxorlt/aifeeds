import { assert, test } from 'vitest';

import {
  applyNewsEditorialReviewDecisions,
  buildNewsSelectionAudit,
  foldNewsEventsForDigest,
  scoreNewsCandidatesForDigest,
  selectNewsByScoreWithAudit,
  suppressCrossDayRepeatedNewsEvents,
  selectTopForSource,
  type NewsCandidateForScoring,
} from './selection';

test('selectTopForSource uses GitHub current-trending time with asOfDate instead of stale scraped_at alone', async () => {
  let sql = '';
  let binds: unknown[] = [];
  const db = {
    prepare(nextSql: string) {
      sql = nextSql;
      const statement = {
        bind(...nextBinds: unknown[]) {
          binds = nextBinds;
          return statement;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
      return statement;
    },
  };

  await selectTopForSource(
    { DB: db } as never,
    'gh',
    20,
    { asOfDate: '2026-07-14' },
  );

  assert.match(sql, /last_seen_on_trending_at/);
  assert.match(sql, /trending_date_str/);
  assert.match(sql, /scraped_at/);
  assert.match(sql, /unixepoch/);
  assert.match(sql, /< datetime\(\?\)/);
  assert.deepEqual(binds, ['github', '2026-07-14', '2026-07-14', 20]);
});

const nowMs = Date.parse('2026-06-25T00:34:56.000Z');

function row(input: Partial<NewsCandidateForScoring> & Pick<NewsCandidateForScoring, 'id' | 'title' | 'sourceCompany' | 'aiCategory'>): NewsCandidateForScoring {
  return {
    id: input.id,
    title: input.title,
    sourceType: input.sourceType || 'blog',
    sourceKey: input.sourceKey || '',
    sourceCompany: input.sourceCompany,
    aiCategory: input.aiCategory,
    publishedAt: input.publishedAt || '2026-06-24T06:00:00.000Z',
    aiSummaryZh: input.aiSummaryZh ?? '摘要',
    content: input.content || '',
    contentTranslated: input.contentTranslated || '',
    transcriptTier: input.transcriptTier || '',
    selectable: input.selectable ?? true,
    eventFingerprint: input.eventFingerprint,
  };
}

test('scoreNewsCandidatesForDigest boosts events reported by multiple independent sources', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:openai:gpt5-immunology',
      title: 'How GPT-5 helped immunologist solve a 3-year-old mystery',
      sourceCompany: 'OpenAI',
      aiCategory: 'research',
      publishedAt: '2026-06-23T17:00:00.000Z',
      aiSummaryZh: 'GPT-5 Pro 应用于免疫学研究。',
    }),
    row({
      id: 'blog:openai:jalapeno-chip',
      title: 'OpenAI and Broadcom unveil LLM-optimized inference chip',
      sourceCompany: 'OpenAI',
      aiCategory: 'product',
      publishedAt: '2026-06-24T06:00:00.000Z',
      aiSummaryZh: 'OpenAI与博通推出定制推理芯片Jalapeño。',
    }),
    row({
      id: 'blog:techcrunch:openai-chip',
      title: 'OpenAI unveils its first custom chip, built by Broadcom',
      sourceCompany: 'TechCrunch',
      aiCategory: '',
      publishedAt: '2026-06-24T14:54:46.000Z',
      selectable: false,
      aiSummaryZh: '',
    }),
    row({
      id: 'blog:the-verge:openai-processor',
      title: 'OpenAI reveals its first AI processor: Jalapeño',
      sourceCompany: 'The Verge',
      aiCategory: '',
      publishedAt: '2026-06-24T14:36:47.000Z',
      selectable: false,
      aiSummaryZh: '',
    }),
    row({
      id: 'blog:aiera:model-release',
      title: '超越Claude Mythos的AI模型，诞生了？',
      sourceCompany: '新智元',
      aiCategory: 'model-release',
      publishedAt: '2026-06-24T00:02:05.000Z',
      aiSummaryZh: '新AI模型性能超越Claude Mythos。',
    }),
  ], nowMs);

  assert.equal(scored[0].id, 'blog:openai:jalapeno-chip');
  const chip = scored.find((item) => item.id === 'blog:openai:jalapeno-chip');
  assert.ok(chip);
  assert.equal(chip.eventSourceCount, 3);
  assert.deepEqual(chip.relatedSourceCompanies.sort(), ['OpenAI', 'TechCrunch', 'The Verge'].sort());
  assert.ok(chip.adjustedScore > (scored.find((item) => item.id === 'blog:openai:gpt5-immunology')?.adjustedScore || 0));
});

test('scoreNewsCandidatesForDigest recognizes Tencent Hunyuan Hy3 as one multi-source model event', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:jiqizhixin:hy3',
      title: '腾讯混元Hy3发布：Agent能力和产品体验跃升',
      sourceCompany: '机器之心',
      aiCategory: 'model-release',
      publishedAt: '2026-07-06T07:37:43.000Z',
      aiSummaryZh: '腾讯7月6日发布混元Hy3模型，总参数295B、激活参数21B，支持256K上下文。',
    }),
    row({
      id: 'blog:tencent:hy3',
      title: 'Tencent Hunyuan Hy3 is now available with stronger agent capabilities',
      sourceCompany: 'Tencent',
      sourceKey: 'tencent-hunyuan',
      aiCategory: 'model-release',
      publishedAt: '2026-07-06T08:00:00.000Z',
      selectable: false,
      aiSummaryZh: '',
    }),
  ], Date.parse('2026-07-07T00:00:00.000Z'));

  const hy3 = scored.find((item) => item.id === 'blog:jiqizhixin:hy3');
  assert.ok(hy3);
  assert.equal(hy3.eventSourceCount, 2);
  assert.deepEqual(hy3.relatedSourceCompanies.sort(), ['Tencent', '机器之心'].sort());
  assert.ok(hy3.adjustedScore > hy3.baseScore);
});

test('buildNewsSelectionAudit records score details and selected flag for top candidates', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:jiqizhixin:hy3',
      title: '腾讯混元Hy3发布：Agent能力和产品体验跃升',
      sourceCompany: '机器之心',
      aiCategory: 'model-release',
      publishedAt: '2026-07-06T07:37:43.000Z',
      aiSummaryZh: '腾讯发布混元Hy3模型，总参数295B、激活参数21B，支持256K上下文。',
    }),
  ], Date.parse('2026-07-07T00:00:00.000Z'));

  const audit = buildNewsSelectionAudit(scored, ['blog:jiqizhixin:hy3']);

  assert.equal(audit.candidates[0].id, 'blog:jiqizhixin:hy3');
  assert.equal(audit.candidates[0].selected, true);
  assert.equal(typeof audit.candidates[0].base_score, 'number');
  assert.equal(typeof audit.candidates[0].adjusted_score, 'number');
  assert.equal(audit.candidates[0].source_company, '机器之心');
  assert.deepEqual(audit.selected_ids, ['blog:jiqizhixin:hy3']);
});

test('applyNewsEditorialReviewDecisions only applies bounded score adjustments with reasons', () => {
  const [hy3] = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:jiqizhixin:hy3',
      title: '腾讯混元Hy3发布：Agent能力和产品体验跃升',
      sourceCompany: '机器之心',
      aiCategory: 'model-release',
      publishedAt: '2026-07-06T07:37:43.000Z',
      aiSummaryZh: '腾讯发布混元Hy3模型，总参数295B、激活参数21B，支持256K上下文。',
    }),
  ], Date.parse('2026-07-07T00:00:00.000Z'));

  const reviewed = applyNewsEditorialReviewDecisions([hy3], [
    { id: 'blog:jiqizhixin:hy3', adjustment: 99, reason: '国产大厂模型正式发布且开放权重。' },
  ]);

  assert.equal(reviewed[0].editorialAdjustment, 6);
  assert.equal(reviewed[0].editorialReason, '国产大厂模型正式发布且开放权重。');
  assert.equal(reviewed[0].adjustedScore, hy3.adjustedScore + 6);
});

test('scoreNewsCandidatesForDigest gives major domestic model launches a modest editorial priority over routine product news', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:jiqizhixin:hy3',
      title: '腾讯混元Hy3发布：Agent能力和产品体验跃升',
      sourceCompany: '机器之心',
      aiCategory: 'model-release',
      publishedAt: '2026-07-06T07:37:43.000Z',
      aiSummaryZh: '腾讯发布混元Hy3模型，总参数295B、激活参数21B，支持256K上下文，并开放权重。',
    }),
    row({
      id: 'blog:databricks:routine-agents',
      title: 'Databricks 用 17 个专业 Agent 自动分诊低严重性安全告警',
      sourceCompany: 'Databricks',
      aiCategory: 'product',
      publishedAt: '2026-07-06T23:30:00.000Z',
      aiSummaryZh: 'Databricks 发布面向企业安全告警分诊的 Agent 工作流。',
    }),
  ], Date.parse('2026-07-07T00:00:00.000Z'));

  assert.equal(scored[0].id, 'blog:jiqizhixin:hy3');
});

test('scoreNewsCandidatesForDigest follows feed ranking freshness and industry-person signals', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:weibo:person',
      title: '李飞飞谈世界模型和机器人下一步',
      sourceCompany: '微博科技热搜',
      aiCategory: 'product',
      publishedAt: '2026-06-24T23:50:00.000Z',
      aiSummaryZh: '李飞飞讨论AI世界模型与机器人。',
    }),
    row({
      id: 'blog:weibo:ordinary',
      title: '世界模型和机器人下一步',
      sourceCompany: '微博科技热搜',
      aiCategory: 'product',
      publishedAt: '2026-06-24T23:50:00.000Z',
      aiSummaryZh: '讨论AI世界模型与机器人。',
    }),
    row({
      id: 'blog:weibo:fresh-product',
      title: '豆包收费功能',
      sourceCompany: '微博科技热搜',
      aiCategory: 'product',
      publishedAt: '2026-06-24T23:55:00.000Z',
      aiSummaryZh: '豆包部分功能开始收费。',
    }),
    row({
      id: 'blog:nvidia:stale-model',
      title: 'NVIDIA releases a model update for enterprise AI',
      sourceCompany: 'NVIDIA',
      aiCategory: 'model-release',
      publishedAt: '2026-06-10T00:00:00.000Z',
      aiSummaryZh: 'NVIDIA发布企业AI模型更新。',
    }),
  ], nowMs);

  const byId = new Map(scored.map((item) => [item.id, item]));
  assert.ok((byId.get('blog:weibo:person')?.baseScore || 0) > (byId.get('blog:weibo:ordinary')?.baseScore || 0));
  assert.ok((byId.get('blog:weibo:fresh-product')?.baseScore || 0) > (byId.get('blog:nvidia:stale-model')?.baseScore || 0));
});

test('foldNewsEventsForDigest keeps one representative per same news event and prefers official source', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:the-verge:gpt56-sol-terra-luna',
      title: 'OpenAI releases GPT-5.6 with Sol, Terra and Luna models',
      sourceCompany: 'The Verge',
      aiCategory: 'model-release',
      publishedAt: '2026-06-26T17:00:00.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布，包含 Sol、Terra、Luna 版本。',
    }),
    row({
      id: 'blog:openai:gpt56-sol-preview',
      title: 'OpenAI publishes GPT-5.6 Sol preview and model details',
      sourceCompany: 'OpenAI',
      sourceKey: 'openai',
      aiCategory: 'model-release',
      publishedAt: '2026-06-26T10:00:00.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布，公开 Sol 版本细节。',
    }),
    row({
      id: 'blog:techcrunch:gpt56-government-limit',
      title: 'OpenAI says restrictions shaped the GPT-5.6 model release',
      sourceCompany: 'TechCrunch',
      aiCategory: 'safety',
      publishedAt: '2026-06-26T18:32:14.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布受到限制，官方回应限制不应成为常态。',
    }),
    row({
      id: 'blog:jiqizhixin:unrelated',
      title: 'Unconventional AI releases a reasoning research result',
      sourceCompany: '机器之心',
      aiCategory: 'research',
      publishedAt: '2026-06-26T16:00:00.000Z',
      aiSummaryZh: 'Unconventional AI 发布新的推理研究结果。',
    }),
  ], Date.parse('2026-06-27T00:00:00.000Z'));

  const folded = foldNewsEventsForDigest(scored);
  const foldedIds = folded.map((item) => item.id);

  assert.equal(foldedIds.filter((id) => id.includes('gpt56')).length, 1);
  assert.equal(foldedIds[0], 'blog:openai:gpt56-sol-preview');
  assert.ok(foldedIds.includes('blog:jiqizhixin:unrelated'));
});

test('foldNewsEventsForDigest treats reordered structured product names as the same launch event', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:the-verge:chatgpt-health',
      title: 'OpenAI is rolling out ChatGPT Health to everyone in the US',
      sourceCompany: 'The Verge',
      sourceKey: 'the-verge',
      aiCategory: 'product',
      publishedAt: '2026-07-23T17:00:00.000Z',
      aiSummaryZh: 'OpenAI 向美国用户全面开放 ChatGPT Health。',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'ChatGPT Health',
        objectFamily: 'ChatGPT',
        objectVariant: 'Health',
        action: 'launch',
        canonicalEvent: 'OpenAI launches ChatGPT Health broadly in the US',
        confidence: 0.95,
      },
    }),
    row({
      id: 'blog:techcrunch:chatgpt-health',
      title: 'OpenAI makes ChatGPT Health available to all US users',
      sourceCompany: 'TechCrunch',
      sourceKey: 'techcrunch',
      aiCategory: 'product',
      publishedAt: '2026-07-23T17:00:00.000Z',
      aiSummaryZh: 'OpenAI 向所有美国用户开放 ChatGPT Health。',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'ChatGPT Health',
        objectFamily: 'ChatGPT',
        objectVariant: 'Health',
        action: 'launch',
        canonicalEvent: 'OpenAI launches ChatGPT Health for all US users',
        confidence: 0.95,
      },
    }),
    row({
      id: 'blog:openai:health-in-chatgpt',
      title: 'Launching Health in ChatGPT',
      sourceCompany: 'OpenAI',
      sourceKey: 'openai',
      aiCategory: 'product',
      publishedAt: '2026-07-23T00:00:00.000Z',
      aiSummaryZh: 'OpenAI 推出 ChatGPT 健康功能，可连接医疗记录与 Apple Health。',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'Health in ChatGPT',
        objectFamily: 'ChatGPT',
        action: 'launch',
        canonicalEvent: 'OpenAI launches Health in ChatGPT for US users',
        confidence: 1,
      },
    }),
  ], Date.parse('2026-07-24T00:00:00.000Z'));

  const official = scored.find((item) => item.id === 'blog:openai:health-in-chatgpt');
  const foldedIds = foldNewsEventsForDigest(scored).map((item) => item.id);

  assert.equal(official?.eventSourceCount, 3);
  assert.deepEqual(foldedIds, ['blog:openai:health-in-chatgpt']);
});

test('foldNewsEventsForDigest folds Anthropic Mythos and Fable policy coverage into one event', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:techcrunch:anthropic-mythos',
      title: 'Trump Admin releases Anthropic Mythos to be used by more than 100 US companies, agencies',
      sourceCompany: 'TechCrunch',
      aiCategory: 'safety',
      publishedAt: '2026-06-27T01:01:37.000Z',
      aiSummaryZh: '美国政府部分解除对Anthropic最先进网络安全模型的禁令，允许指定机构使用。',
    }),
    row({
      id: 'blog:the-verge:anthropic-mythos',
      title: 'Anthropic’s Mythos 5 is back',
      sourceCompany: 'The Verge',
      aiCategory: 'model-release',
      publishedAt: '2026-06-27T00:33:44.000Z',
      aiSummaryZh: 'Anthropic 高端模型 Mythos 5 获政府批准有限回归，但公众版 Fable 5 仍搁置。',
    }),
    row({
      id: 'blog:aiera:anthropic-fable',
      title: 'Fable 5开始灰度解禁？6月26日大限倒计时',
      sourceCompany: '新智元',
      aiCategory: 'model-release',
      publishedAt: '2026-06-27T00:01:44.000Z',
      aiSummaryZh: 'Fable 5 开始灰度回归并出现每周配额定档迹象，Sonnet 5 前瞻性泄露，Anthropic 在国会大考前夕动作频频。',
    }),
    row({
      id: 'blog:jiqizhixin:unrelated',
      title: 'Unconventional AI releases a reasoning research result',
      sourceCompany: '机器之心',
      aiCategory: 'research',
      publishedAt: '2026-06-26T16:00:00.000Z',
      aiSummaryZh: 'Unconventional AI 发布新的推理研究结果。',
    }),
  ], Date.parse('2026-06-27T03:00:00.000Z'));

  const foldedIds = foldNewsEventsForDigest(scored).map((item) => item.id);

  assert.equal(foldedIds.filter((id) => id.includes('anthropic')).length, 1);
  assert.ok(foldedIds.includes('blog:jiqizhixin:unrelated'));
});

test('suppressCrossDayRepeatedNewsEvents removes prior media repeats but allows a newer official source', () => {
  const candidates = [
    row({
      id: 'blog:the-verge:gpt56-sol-terra-luna',
      title: 'OpenAI releases GPT-5.6 with Sol, Terra and Luna models',
      sourceCompany: 'The Verge',
      aiCategory: 'model-release',
      publishedAt: '2026-06-26T17:00:00.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布，包含 Sol、Terra、Luna 版本。',
    }),
    row({
      id: 'blog:openai:gpt56-sol-preview',
      title: 'OpenAI publishes GPT-5.6 Sol preview and model details',
      sourceCompany: 'OpenAI',
      sourceKey: 'openai',
      aiCategory: 'model-release',
      publishedAt: '2026-06-26T10:00:00.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布，公开 Sol 版本细节。',
    }),
    row({
      id: 'blog:techcrunch:gpt56-government-limit',
      title: 'OpenAI says restrictions shaped the GPT-5.6 model release',
      sourceCompany: 'TechCrunch',
      aiCategory: 'safety',
      publishedAt: '2026-06-26T18:32:14.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布受到限制，官方回应限制不应成为常态。',
    }),
    row({
      id: 'blog:jiqizhixin:unrelated',
      title: 'Unconventional AI releases a reasoning research result',
      sourceCompany: '机器之心',
      aiCategory: 'research',
      publishedAt: '2026-06-26T16:00:00.000Z',
      aiSummaryZh: 'Unconventional AI 发布新的推理研究结果。',
    }),
  ];
  const prior = [
    row({
      id: 'blog:the-verge:previous-gpt56-delay',
      title: 'OpenAI will delay GPT-5.6 after administration request',
      sourceCompany: 'The Verge',
      aiCategory: 'model-release',
      publishedAt: '2026-06-25T18:00:00.000Z',
      aiSummaryZh: 'OpenAI GPT-5.6 模型发布被推迟，涉及外部限制。',
    }),
  ];

  const filteredIds = suppressCrossDayRepeatedNewsEvents(candidates, prior).map((item) => item.id);

  assert.deepEqual(filteredIds.sort(), [
    'blog:jiqizhixin:unrelated',
    'blog:openai:gpt56-sol-preview',
  ].sort());
});

test('suppressCrossDayRepeatedNewsEvents removes a later hands-on review of the already-pushed Codex Micro launch', () => {
  const candidates = [
    row({
      id: 'blog:techcrunch:micro-keypad-review',
      title: 'I tried out OpenAI’s new AI keypad',
      sourceCompany: 'TechCrunch',
      sourceKey: 'techcrunch',
      aiCategory: 'product',
      publishedAt: '2026-07-25T00:23:11.000Z',
      aiSummaryZh: 'OpenAI 的硬件首秀 Micro 是一款可编程快捷键键盘。',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'Micro keypad',
        action: 'launch',
        canonicalEvent: 'OpenAI launches Micro keypad in collaboration with Work Louder',
        confidence: 0.95,
      },
    }),
  ];
  const prior = [
    row({
      id: 'blog:the-verge:codex-micro-launch',
      title: 'OpenAI finally launches hardware… for Codex',
      sourceCompany: 'The Verge',
      sourceKey: 'the-verge',
      aiCategory: 'product',
      publishedAt: '2026-07-15T16:00:00.000Z',
      aiSummaryZh: 'OpenAI 发布 Codex 专用宏键盘 Codex Micro。',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'Codex Micro',
        objectFamily: 'Codex',
        action: 'launch',
        canonicalEvent: 'OpenAI launches Codex Micro, a programmable keypad for Codex, in collaboration with Work Louder',
        confidence: 0.95,
      },
    }),
  ];

  const filteredIds = suppressCrossDayRepeatedNewsEvents(candidates, prior).map((item) => item.id);

  assert.deepEqual(filteredIds, []);
});

test('suppressCrossDayRepeatedNewsEvents keeps different products that only share a collaborator and audience', () => {
  const candidates = [
    row({
      id: 'blog:techcrunch:beta-keyboard',
      title: 'OpenAI launches Beta Keyboard',
      sourceCompany: 'TechCrunch',
      aiCategory: 'product',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'Beta Keyboard',
        action: 'launch',
        canonicalEvent: 'OpenAI launches Beta Keyboard with Work Louder for developers',
        confidence: 0.95,
      },
    }),
  ];
  const prior = [
    row({
      id: 'blog:the-verge:alpha-pad',
      title: 'OpenAI launches Alpha Pad',
      sourceCompany: 'The Verge',
      aiCategory: 'product',
      eventFingerprint: {
        eventType: 'product_launch',
        primaryActor: 'OpenAI',
        primaryObject: 'Alpha Pad',
        action: 'launch',
        canonicalEvent: 'OpenAI launches Alpha Pad with Work Louder for developers',
        confidence: 0.95,
      },
    }),
  ];

  const filteredIds = suppressCrossDayRepeatedNewsEvents(candidates, prior).map((item) => item.id);

  assert.deepEqual(filteredIds, ['blog:techcrunch:beta-keyboard']);
});

test('selectNewsByScoreWithAudit uses a 30-day ledger for cross-day event deduplication', async () => {
  let ledgerBinds: unknown[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...binds: unknown[]) {
          if (/FROM digest_pool/.test(sql)) ledgerBinds = binds;
          return statement;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
      return statement;
    },
  };

  await selectNewsByScoreWithAudit(
    { DB: db } as never,
    5,
    { strictCrossDayEventDedup: true },
  );

  assert.equal(Number(ledgerBinds[1]) - Number(ledgerBinds[0]), 30 * 86400_000);
});

test('selectNewsByScoreWithAudit does not truncate matching events after the first 300 ledger IDs', async () => {
  const currentId = 'blog:techcrunch:current-review';
  const priorId = 'blog:the-verge:prior-launch';
  const fingerprint = {
    event_type: 'product_launch',
    primary_actor: 'Example AI',
    primary_object: 'Example Pad',
    action: 'launch',
    canonical_event: 'Example AI launches Example Pad',
    confidence: 0.95,
  };
  const currentRow = {
    id: currentId,
    title: 'A later review of Example Pad',
    source_type: 'blog',
    content: '',
    content_translated: '',
    published_at: '2026-07-25T00:00:00.000Z',
    extra: JSON.stringify({
      title_zh: 'Example Pad 后续体验',
      ai_summary_zh: 'Example Pad 后续体验。',
      ai_category: 'product',
      source_company: 'TechCrunch',
      feed_key: 'techcrunch',
      event_fingerprint: fingerprint,
    }),
  };
  const priorRow = {
    id: priorId,
    title: 'Example AI launches Example Pad',
    source_type: 'blog',
    content: '',
    content_translated: '',
    published_at: '2026-07-15T00:00:00.000Z',
    extra: JSON.stringify({
      title_zh: 'Example Pad 正式发布',
      ai_summary_zh: 'Example Pad 正式发布。',
      ai_category: 'product',
      source_company: 'The Verge',
      feed_key: 'the-verge',
      event_fingerprint: fingerprint,
    }),
  };
  const ledgerIds = [
    ...Array.from({ length: 300 }, (_, index) => `blog:history:${index}`),
    priorId,
  ];
  const fetchedBatches: string[][] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...nextBinds: unknown[]) {
          binds = nextBinds;
          return statement;
        },
        async all<T>() {
          if (/FROM items\s+WHERE source_type IN/.test(sql)) {
            return { results: [currentRow] as T[] };
          }
          if (/FROM digest_pool/.test(sql)) {
            return { results: ledgerIds.map((id) => ({ id })) as T[] };
          }
          if (/WHERE id IN/.test(sql)) {
            const ids = binds.map(String);
            fetchedBatches.push(ids);
            return { results: (ids.includes(priorId) ? [priorRow] : []) as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return statement;
    },
  };

  const result = await selectNewsByScoreWithAudit(
    { DB: db } as never,
    5,
    { strictCrossDayEventDedup: true },
  );

  assert.ok(fetchedBatches.flat().includes(priorId));
  assert.deepEqual(result.ids, []);
});

test('suppressCrossDayRepeatedNewsEvents does not suppress a new Claude Sonnet launch because of prior Claude infrastructure coverage', () => {
  const candidates = [
    row({
      id: 'blog:techcrunch:claude-sonnet-5',
      title: 'Anthropic launches Claude Sonnet 5 as a cheaper way to run agents',
      sourceCompany: 'TechCrunch',
      aiCategory: 'model-release',
      publishedAt: '2026-06-30T18:00:00.000Z',
      aiSummaryZh: 'Anthropic 发布 Claude Sonnet 5，主打低成本智能体运行。',
    }),
  ];
  const prior = [
    row({
      id: 'blog:nvidia:claude-gb300',
      title: 'Claude Meets Blackwell Ultra: Anthropic’s Models Now Run on NVIDIA GB300 in Azure',
      sourceCompany: 'NVIDIA',
      sourceKey: 'nvidia',
      aiCategory: 'product',
      publishedAt: '2026-06-29T17:00:19.000Z',
      aiSummaryZh: 'Claude 模型在 Azure 上运行 NVIDIA GB300 芯片，正式可用。',
    }),
  ];

  const filteredIds = suppressCrossDayRepeatedNewsEvents(candidates, prior).map((item) => item.id);

  assert.deepEqual(filteredIds, ['blog:techcrunch:claude-sonnet-5']);
});

test('foldNewsEventsForDigest keeps Claude Sonnet 5 separate from Claude Science and NVIDIA integration stories', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:anthropic:claude-sonnet-5',
      title: 'Introducing Claude Sonnet 5',
      sourceCompany: 'Anthropic',
      sourceKey: 'anthropic',
      aiCategory: 'model-release',
      publishedAt: '2026-06-30T00:00:00.000Z',
      aiSummaryZh: 'Claude Sonnet 5 发布：性能接近 Opus 4.8，定价更低。',
    }),
    row({
      id: 'blog:nvidia:claude-science-bionemo',
      title: 'NVIDIA BioNeMo Agent Toolkit Brings Accelerated AI to Life Sciences Researchers in Claude Science',
      sourceCompany: 'NVIDIA',
      sourceKey: 'nvidia',
      aiCategory: 'product',
      publishedAt: '2026-06-30T17:00:38.000Z',
      aiSummaryZh: 'NVIDIA BioNeMo 代理工具包集成 Claude Science，加速 AI 科研。',
    }),
    row({
      id: 'blog:mit:claude-science',
      title: 'Claude Science is Anthropic’s newest flagship product',
      sourceCompany: 'MIT Technology Review',
      aiCategory: 'product',
      publishedAt: '2026-06-30T21:50:04.000Z',
      aiSummaryZh: 'Anthropic 发布 Claude Science，瞄准科研领域。',
    }),
  ], Date.parse('2026-07-01T00:00:16.000Z'));

  const foldedIds = foldNewsEventsForDigest(scored).map((item) => item.id);

  assert.ok(foldedIds.includes('blog:anthropic:claude-sonnet-5'));
  assert.ok(foldedIds.some((id) => id.includes('claude-science')));
});

test('suppressCrossDayRepeatedNewsEvents removes a repeated LongCat 2.0 event across sources using structured fingerprints', () => {
  const candidates = [
    row({
      id: 'blog:qbitai:longcat2',
      title: '全球首个英伟达含量为0的万亿模型，成了海外开发者的抢手货',
      sourceCompany: '量子位',
      aiCategory: 'model-release',
      publishedAt: '2026-07-02T10:56:23.000Z',
      aiSummaryZh: '国产算力首次跑通万亿参数大模型全链路，且通过市场匿名验证，证明降本增效的可行性。',
      eventFingerprint: {
        eventType: 'model_release',
        primaryActor: 'LongCat',
        primaryObject: 'LongCat-2.0',
        objectFamily: 'LongCat',
        objectVersion: '2.0',
        action: 'launch',
        canonicalEvent: 'LongCat-2.0 模型发布',
        confidence: 0.95,
      },
    }),
  ];
  const prior = [
    row({
      id: 'blog:meituan-tech:longcat2',
      title: '美团 LongCat-2.0 正式发布：在国产算力集群上完成全流程训练与推理的万亿参数模型',
      sourceCompany: '美团技术团队',
      aiCategory: 'model-release',
      publishedAt: '2026-06-30T00:00:00.000Z',
      aiSummaryZh: '美团LongCat-2.0证明了国产算力能训好万亿参数模型。',
      eventFingerprint: {
        eventType: 'model_release',
        primaryActor: '美团',
        primaryObject: 'LongCat-2.0',
        objectFamily: 'LongCat',
        objectVersion: '2.0',
        action: 'launch',
        canonicalEvent: '美团发布万亿参数模型LongCat-2.0并开源，基于国产算力集群训练',
        confidence: 1,
      },
    }),
  ];

  const filteredIds = suppressCrossDayRepeatedNewsEvents(candidates, prior).map((item) => item.id);

  assert.deepEqual(filteredIds, []);
});

test('suppressCrossDayRepeatedNewsEvents keeps a new Fable 5 global redeploy after older partial-policy coverage', () => {
  const candidates = [
    row({
      id: 'blog:aiera:fable-global-return',
      title: '刚刚，Fable 5全球解禁！',
      sourceCompany: '新智元',
      aiCategory: 'company',
      publishedAt: '2026-07-02T00:01:46.000Z',
      aiSummaryZh: '美国商务部解除了对Anthropic最强编码模型Fable 5的出口禁令，明天恢复访问。',
      eventFingerprint: {
        eventType: 'policy_access',
        primaryActor: 'US Department of Commerce',
        primaryObject: 'Claude Fable 5 and Mythos 5',
        objectFamily: 'Claude',
        objectVariant: 'Fable, Mythos',
        objectVersion: '5',
        action: 'approve',
        canonicalEvent: '美国商务部解除对Anthropic Claude Fable 5和Mythos 5的出口管制',
        confidence: 1,
      },
    }),
  ];
  const prior = [
    row({
      id: 'blog:the-verge:mythos-back-fable-still-blocked',
      title: 'Anthropic’s Mythos 5 is back',
      sourceCompany: 'The Verge',
      aiCategory: 'model-release',
      publishedAt: '2026-06-27T00:33:44.000Z',
      aiSummaryZh: 'Anthropic 高端模型 Mythos 5 获政府批准有限回归，但公众版 Fable 5 仍搁置。',
      eventFingerprint: {
        eventType: 'policy_access',
        primaryActor: 'Anthropic',
        primaryObject: 'Claude Mythos 5',
        objectFamily: 'Claude',
        objectVariant: 'Mythos',
        objectVersion: '5',
        action: 'approve',
        canonicalEvent: 'Anthropic Mythos 5 回归但 Fable 5 仍未恢复访问',
        confidence: 0.9,
      },
    }),
  ];

  const filteredIds = suppressCrossDayRepeatedNewsEvents(candidates, prior).map((item) => item.id);

  assert.deepEqual(filteredIds, ['blog:aiera:fable-global-return']);
});

test('scoreNewsCandidatesForDigest gives Fable 5 redeploy policy-access coverage enough weight to compete with routine product news', () => {
  const scored = scoreNewsCandidatesForDigest([
    row({
      id: 'blog:aiera:fable-global-return',
      title: '刚刚，Fable 5全球解禁！',
      sourceCompany: '新智元',
      aiCategory: 'company',
      publishedAt: '2026-07-02T00:01:46.000Z',
      aiSummaryZh: '美国商务部撤销Anthropic Fable 5出口管制，明天恢复全球访问。',
      eventFingerprint: {
        eventType: 'policy_access',
        primaryActor: 'US Department of Commerce',
        primaryObject: 'Claude Fable 5 and Mythos 5',
        objectFamily: 'Claude',
        objectVariant: 'Fable, Mythos',
        objectVersion: '5',
        action: 'approve',
        canonicalEvent: '美国商务部解除对Anthropic Claude Fable 5和Mythos 5的出口管制',
        confidence: 1,
      },
    }),
    row({
      id: 'blog:databricks:routine-ai-impact',
      title: 'The 3 questions to answer to take AI from experimentation to impact',
      sourceCompany: 'Databricks',
      aiCategory: 'product',
      publishedAt: '2026-07-02T17:04:19.000Z',
      aiSummaryZh: '企业AI规模化需解决治理、集成与安全实验三大问题。',
    }),
  ], Date.parse('2026-07-03T00:00:00.000Z'));

  assert.equal(scored[0].id, 'blog:aiera:fable-global-return');
  assert.ok((scored[0].adjustedScore - scored[1].adjustedScore) >= 4);
});

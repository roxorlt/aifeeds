import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDigestSubjectFallback, digestSubjectTitleFromRow } from './subject';

test('digest subject title uses enriched Chinese title before raw clickbait title', () => {
  const title = digestSubjectTitleFromRow({
    title: '超越Claude Mythos的AI模型，诞生了？',
    content_translated: null,
    content: null,
    extra: JSON.stringify({ title_zh: 'Sakana AI 发布 Fugu 多智能体系统' }),
  });

  assert.equal(title, 'Sakana AI 发布 Fugu 多智能体系统');
});

test('digest subject fallback joins top three titles instead of generic placeholder', () => {
  const subject = buildDigestSubjectFallback([
    'Claude 发布 Tag 工具',
    'GPT-5 帮助破解免疫学 3 年难题',
    '研究者提出多轮反射掩码方法',
    '第四条不应进入标题',
  ]);

  assert.equal(subject, 'Claude 发布 Tag 工具、GPT-5 帮助破解免疫学 3 年难题、研究者提出多轮反射掩码方法');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFeedEventFingerprint,
  selectEnrichExcerptForFeeds,
  validateFeedEnrichGrounding,
} from './classify-translate';

test('selectEnrichExcerptForFeeds prefers full blog body over RSS image-only excerpt', () => {
  const excerpt = '<img src="https://example.com/cover.png">';
  const bodyMarkdownZh = [
    'Fugu 并非传统意义上的 AI 模型。',
    '它是 Sakana AI 发布的多智能体系统，能够调度多个专家模型完成复杂任务。',
  ].join('\n');

  const selected = selectEnrichExcerptForFeeds('blog', {
    content: excerpt,
    extra: {
      excerpt,
      body_markdown_zh: bodyMarkdownZh,
      body_markdown: 'Fugu is not a traditional AI model. It is a multi-agent system.',
    },
  });

  assert.match(selected, /多智能体系统/);
  assert.doesNotMatch(selected, /^<img\b/);
});

test('validateFeedEnrichGrounding flags output that omits the body subject and overfits clickbait title', () => {
  const result = validateFeedEnrichGrounding({
    sourceTitle: '超越Claude Mythos的AI模型，诞生了？',
    sourceText: 'Sakana AI 发布了 Fugu。Fugu 并非传统意义上的 AI 模型，而是一个多智能体系统，用于调度多个专家模型完成编程、科学推理和复杂多步骤任务。',
    titleZh: '新AI模型超越Claude Mythos',
    summaryZh: '新AI模型性能超越Claude Mythos，显示模型能力快速迭代。',
  });

  assert.equal(result.suspect, true);
  assert.match(result.reason, /missing_body_subject/);
});

test('normalizeFeedEventFingerprint preserves same-event fields and clamps confidence', () => {
  const fp = normalizeFeedEventFingerprint({
    event_type: 'model_release',
    primary_actor: 'Anthropic',
    primary_object: 'Claude Sonnet 5',
    object_family: 'Claude',
    object_variant: 'Sonnet',
    object_version: '5',
    action: 'launch',
    canonical_event: 'Anthropic launches Claude Sonnet 5',
    confidence: 1.2,
  });

  assert.deepEqual(fp, {
    event_type: 'model_release',
    primary_actor: 'Anthropic',
    primary_object: 'Claude Sonnet 5',
    object_family: 'Claude',
    object_variant: 'Sonnet',
    object_version: '5',
    action: 'launch',
    canonical_event: 'Anthropic launches Claude Sonnet 5',
    confidence: 1,
  });
});

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { clampSentences, renderItem, type RenderRow } from './render';

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('clampSentences truncates on Unicode code-point boundaries', () => {
  const value = 'a'.repeat(149) + '🔥' + 'tail';
  const result = clampSentences(value, 150);

  assert.equal(result, 'a'.repeat(149) + '🔥…');
  assert.equal(hasLoneSurrogate(result), false);
});

test('clampSentences replaces an upstream lone surrogate even when no truncation is needed', () => {
  const result = clampSentences('prefix \ud83d suffix', 100);

  assert.equal(result, 'prefix \ufffd suffix');
  assert.equal(hasLoneSurrogate(result), false);
});

test('renderItem uses blog body assets as news cover and media when row media is empty', () => {
  const row: RenderRow = {
    id: 'blog:aiera:7a92bf376b043118',
    title: '超越Claude Mythos的AI模型，诞生了？',
    content: '',
    content_translated: null,
    author: null,
    handle: null,
    url: 'https://aiera.com.cn/post',
    media: null,
    extra: JSON.stringify({
      title_zh: 'Sakana AI 发布 Fugu 多智能体系统',
      ai_summary_zh: 'Sakana AI 发布 Fugu 多智能体系统，通过调度专家模型完成复杂任务。',
      body: {
        assets: [
          {
            url: '/r/blog/fugu-cover.png',
            kind: 'image',
            role: 'inline',
          },
        ],
      },
    }),
  };

  const item = renderItem('news', row, 1, 'https://api.ai-feeds.com');

  assert.equal(item.cover, 'https://api.ai-feeds.com/r/blog/fugu-cover.png');
  assert.deepEqual(item.media, [
    { type: 'image', url: 'https://api.ai-feeds.com/r/blog/fugu-cover.png' },
  ]);
});

test('renderItem extracts inline blog images from body markdown/html when assets are empty', () => {
  const row: RenderRow = {
    id: 'blog:jiqizhixin:adfe087259e13dbe',
    title: '刚刚，豆包大模型2.1发布，又一次跨越生产级质变点',
    content: '',
    content_translated: null,
    author: null,
    handle: null,
    url: 'https://www.jiqizhixin.com/articles/2026-06-23-14',
    media: null,
    extra: JSON.stringify({
      title_zh: '豆包大模型 2.1 发布',
      ai_summary_zh: '豆包大模型 2.1 发布，强化代码与 Agent 能力。',
      body: { assets: [] },
      body_markdown: '<img src="https://image.jiqizhixin.com/uploads/article/cover_image/doubao.jpg" referrerpolicy="no-referrer"><section>编辑｜机器之心</section>',
    }),
  };

  const item = renderItem('news', row, 1, 'https://api.ai-feeds.com');

  assert.equal(item.cover, 'https://image.jiqizhixin.com/uploads/article/cover_image/doubao.jpg');
  assert.deepEqual(item.media, [
    { type: 'image', url: 'https://image.jiqizhixin.com/uploads/article/cover_image/doubao.jpg' },
  ]);
});

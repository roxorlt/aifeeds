import test from 'node:test';
import assert from 'node:assert/strict';

import { detectIndustryPersonMentions, scoreFeedNewsItemForOrdering, type FeedNewsRankInput } from './ranking';

const nowMs = Date.parse('2026-06-26T02:00:00.000Z');

function item(input: Partial<FeedNewsRankInput> & Pick<FeedNewsRankInput, 'id' | 'title'>): FeedNewsRankInput {
  return {
    id: input.id,
    title: input.title,
    sourceType: input.sourceType || 'blog',
    sourceKey: input.sourceKey || 'weibo-hot-tech',
    sourceCompany: input.sourceCompany || '微博科技热搜',
    aiCategory: input.aiCategory || 'company',
    publishedAt: input.publishedAt || '2026-06-26T01:20:00.000Z',
    hasSummary: input.hasSummary ?? true,
    hasBody: input.hasBody ?? true,
    heat: input.heat,
  };
}

test('detectIndustryPersonMentions matches raw title people names in Chinese and English', () => {
  assert.deepEqual(detectIndustryPersonMentions('李飞飞说未来职场将只剩下这两种人'), ['李飞飞']);
  assert.deepEqual(detectIndustryPersonMentions('Dario Amodei talks about Baidu and AI agents'), ['Dario Amodei']);
  assert.deepEqual(detectIndustryPersonMentions('豆包收费功能'), []);
});

test('scoreFeedNewsItemForOrdering boosts raw titles containing industry leaders', () => {
  const ordinary = scoreFeedNewsItemForOrdering(item({
    id: 'ordinary',
    title: '豆包收费功能',
    aiCategory: 'product',
  }), nowMs);
  const withPerson = scoreFeedNewsItemForOrdering(item({
    id: 'person',
    title: '李飞飞说未来职场将只剩下这两种人',
    aiCategory: 'product',
  }), nowMs);

  assert.ok(withPerson.total > ordinary.total);
  assert.equal(withPerson.breakdown.industryPerson, 12);
  assert.deepEqual(withPerson.industryPeople, ['李飞飞']);
});

test('scoreFeedNewsItemForOrdering keeps relevance and freshness stronger than person-name boost', () => {
  const freshModelRelease = scoreFeedNewsItemForOrdering(item({
    id: 'fresh-model',
    title: 'DeepSeek大规模招聘',
    aiCategory: 'model-release',
    publishedAt: '2026-06-26T01:40:00.000Z',
  }), nowMs);
  const stalePersonOpinion = scoreFeedNewsItemForOrdering(item({
    id: 'stale-person',
    title: 'Sam Altman谈十年前的创业往事',
    aiCategory: 'other',
    publishedAt: '2026-06-18T01:40:00.000Z',
  }), nowMs);

  assert.ok(freshModelRelease.total > stalePersonOpinion.total);
});

test('scoreFeedNewsItemForOrdering does not let stale high-authority model posts outrank fresh news', () => {
  const freshProductNews = scoreFeedNewsItemForOrdering(item({
    id: 'fresh-product',
    title: '豆包收费功能',
    aiCategory: 'product',
    publishedAt: '2026-06-26T01:40:00.000Z',
    sourceCompany: '微博科技热搜',
    sourceKey: 'weibo-hot-tech',
  }), nowMs);
  const staleModelRelease = scoreFeedNewsItemForOrdering(item({
    id: 'stale-model',
    title: 'NVIDIA Accelerates Google DeepMind Diffusion Model',
    aiCategory: 'model-release',
    publishedAt: '2026-06-10T16:15:20.000Z',
    sourceCompany: 'NVIDIA',
    sourceKey: 'nvidia',
  }), nowMs);

  assert.ok(freshProductNews.total > staleModelRelease.total);
});

test('scoreFeedNewsItemForOrdering treats major Chinese AI labs as first-party model sources', () => {
  const tencent = scoreFeedNewsItemForOrdering(item({
    id: 'tencent-hy3',
    title: '腾讯发布混元Hy3模型，Agent能力和产品体验跃升',
    aiCategory: 'model-release',
    sourceCompany: 'Tencent',
    sourceKey: 'tencent-hunyuan',
  }), nowMs);
  const media = scoreFeedNewsItemForOrdering(item({
    id: 'media-hy3',
    title: '腾讯发布混元Hy3模型，Agent能力和产品体验跃升',
    aiCategory: 'model-release',
    sourceCompany: '机器之心',
    sourceKey: 'jiqizhixin',
  }), nowMs);

  assert.equal(tencent.breakdown.sourceAuthority, 10);
  assert.equal(media.breakdown.sourceAuthority, 9);
  assert.ok(tencent.total > media.total);
});

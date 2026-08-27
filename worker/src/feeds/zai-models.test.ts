import { assert, beforeEach, test, vi } from 'vitest';

const { fetchPageMock, fetchTextMock } = vi.hoisted(() => ({
  fetchPageMock: vi.fn(),
  fetchTextMock: vi.fn(),
}));

vi.mock('./extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extract')>()),
  throttledFetchText: fetchTextMock,
  throttledFetchTextPage: fetchPageMock,
}));

import { idHashOf, nextPageUrlFromLinkHeader } from './extract';
import { getFeedDef } from './registry';
import { discoverZaiOrgModels, parseZaiOrgModelList } from './zai-models';

const NOW = new Date('2026-08-27T12:00:00.000Z');

function modelFixture(index: number, overrides: Record<string, unknown> = {}) {
  const suffix = String(index).padStart(4, '0');
  return {
    _id: `66cf0000000000000000${suffix}`,
    id: `zai-org/fixture-model-${suffix}`,
    modelId: `zai-org/fixture-model-${suffix}`,
    author: 'zai-org',
    private: false,
    downloads: 100 + index,
    likes: index,
    tags: ['transformers', 'text-generation'],
    pipeline_tag: 'text-generation',
    createdAt: '2026-08-26T01:00:00.000Z',
    lastModified: '2026-08-27T01:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  fetchPageMock.mockReset();
  fetchTextMock.mockReset();
});

test('official API Link header resolves the next cursor URL and ignores non-next relations', () => {
  assert.equal(
    nextPageUrlFromLinkHeader(
      '<https://huggingface.co/api/models?author=zai-org&cursor=abc>; rel="next", <https://huggingface.co/api/models?author=zai-org>; rel="first"',
      'https://huggingface.co/api/models?author=zai-org&limit=50',
    ),
    'https://huggingface.co/api/models?author=zai-org&cursor=abc',
  );
  assert.equal(
    nextPageUrlFromLinkHeader('<https://huggingface.co/api/models?author=zai-org>; rel="first"', 'https://huggingface.co/api/models'),
    null,
  );
});

test('Z.ai model discovery uses the official zai-org model-list source definition', () => {
  const feed = getFeedDef('blog:zai-models');

  assert.ok(feed);
  assert.equal(feed.source_company, 'Z.ai');
  assert.equal(feed.editorial_type, 'official');
  assert.match(feed.feed_url, /^https:\/\/huggingface\.co\/api\/models\?/);
  assert.match(feed.feed_url, /sort=createdAt/);
});

test('Z.ai discovery follows bounded official API pagination and finds a model after item 50', async () => {
  const feed = getFeedDef('blog:zai-models');
  assert.ok(feed);
  const firstPage = Array.from({ length: 50 }, (_, index) => modelFixture(index));
  const target = modelFixture(51, {
    _id: '66cf0000000000000000target',
    id: 'zai-org/GLM-5.3-Flash',
    modelId: 'zai-org/GLM-5.3-Flash',
  });
  const nextUrl = 'https://huggingface.co/api/models?author=zai-org&cursor=page-2';
  fetchTextMock.mockResolvedValue(JSON.stringify(firstPage));
  fetchPageMock
    .mockResolvedValueOnce({ body: JSON.stringify(firstPage), nextUrl })
    .mockResolvedValueOnce({ body: JSON.stringify([target]), nextUrl: null });

  const items = await discoverZaiOrgModels(feed, { now: NOW, fetchPage: fetchPageMock });

  assert.ok(items.some((item) => item.link === 'https://huggingface.co/zai-org/GLM-5.3-Flash'));
  assert.equal(fetchPageMock.mock.calls.length, 2);
});

test('Z.ai immutable model id survives a repository rename and ordinary lastModified updates', () => {
  const immutableId = '66cf0000000000000000abcd';
  const initial = parseZaiOrgModelList(JSON.stringify([
    modelFixture(1, { _id: immutableId, id: 'zai-org/GLM-5.3-Flash', modelId: 'zai-org/GLM-5.3-Flash' }),
  ]), NOW);
  const renamed = parseZaiOrgModelList(JSON.stringify([
    modelFixture(1, {
      _id: immutableId,
      id: 'zai-org/GLM-5.3-Flash-Base',
      modelId: 'zai-org/GLM-5.3-Flash-Base',
      lastModified: '2026-08-27T11:00:00.000Z',
    }),
  ]), NOW);

  assert.equal(initial[0].guid, renamed[0].guid);
  assert.equal(idHashOf(initial[0].guid), idHashOf(renamed[0].guid));
  assert.equal(renamed[0].link, 'https://huggingface.co/zai-org/GLM-5.3-Flash-Base');
  assert.equal(renamed[0].published_at, '2026-08-26T01:00:00.000Z');
});

test('Z.ai discovery rejects missing immutable/release fields and never uses a normal update as release time', () => {
  const rows = [
    modelFixture(1, { _id: undefined }),
    modelFixture(2, { createdAt: undefined, lastModified: '2026-08-27T11:00:00.000Z' }),
    modelFixture(3, {
      createdAt: '2024-01-01T00:00:00.000Z',
      lastModified: '2026-08-27T11:00:00.000Z',
    }),
    modelFixture(4, { private: true }),
  ];

  assert.deepEqual(parseZaiOrgModelList(JSON.stringify(rows), NOW), []);
});

test('an old repository first observed after private-to-public visibility is not a pseudo-release', () => {
  const nowPublic = modelFixture(9, {
    private: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    lastModified: '2026-08-27T11:00:00.000Z',
  });

  assert.deepEqual(parseZaiOrgModelList(JSON.stringify([nowPublic]), NOW), []);
});

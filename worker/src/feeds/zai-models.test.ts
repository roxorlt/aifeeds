import { assert, test } from 'vitest';

import { idHashOf } from './extract';
import { getFeedDef } from './registry';

test('Z.ai model discovery uses the official zai-org model-list source definition', () => {
  const feed = getFeedDef('blog:zai-models');

  assert.ok(feed);
  assert.equal(feed.source_company, 'Z.ai');
  assert.equal(feed.editorial_type, 'official');
  assert.match(feed.feed_url, /^https:\/\/huggingface\.co\/api\/models\?/);
});

test('Z.ai model-list fixture keeps an existing repository identity stable across ordinary lastModified updates', async () => {
  const modulePath = './zai-models';
  const zaiModels = await import(modulePath).catch(() => null) as {
    parseZaiOrgModelList?: (body: string) => Array<{ guid: string; link: string; title: string }>;
  } | null;
  assert.ok(zaiModels?.parseZaiOrgModelList, 'Z.ai model-list parser is missing');

  const initial = zaiModels.parseZaiOrgModelList!(JSON.stringify([
    {
      id: 'zai-org/GLM-5.3-Flash',
      author: 'zai-org',
      createdAt: '2026-08-26T01:00:00.000Z',
      lastModified: '2026-08-26T01:00:00.000Z',
    },
  ]));
  const refreshed = zaiModels.parseZaiOrgModelList!(JSON.stringify([
    {
      id: 'zai-org/GLM-5.3-Flash',
      author: 'zai-org',
      createdAt: '2026-08-26T01:00:00.000Z',
      lastModified: '2026-08-27T01:00:00.000Z',
    },
  ]));

  assert.deepEqual(initial.map((item) => item.guid), ['zai-org/GLM-5.3-Flash']);
  assert.equal(initial[0].guid, refreshed[0].guid);
  assert.equal(idHashOf(initial[0].guid), idHashOf(refreshed[0].guid));
  assert.equal(initial[0].link, 'https://huggingface.co/zai-org/GLM-5.3-Flash');
});

import { assert, test, vi } from 'vitest';

const { mockedFetchText } = vi.hoisted(() => ({ mockedFetchText: vi.fn() }));

vi.mock('./extract', () => ({ throttledFetchText: mockedFetchText }));

import { discoverPageIndex } from './page-index';
import { getFeedDef } from './registry';

test('Anthropic official sitemap discovery keeps only /news/<slug> article pages', async () => {
  const feed = getFeedDef('blog:anthropic');
  assert.ok(feed);
  mockedFetchText.mockResolvedValue(`
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.anthropic.com/news/claude-for-enterprise</loc><lastmod>2026-08-26</lastmod></url>
      <url><loc>https://www.anthropic.com/news</loc><lastmod>2026-08-26</lastmod></url>
      <url><loc>https://www.anthropic.com/research/model-behavior</loc><lastmod>2026-08-26</lastmod></url>
      <url><loc>https://www.anthropic.com/news/claude-code-security</loc><lastmod>2026-08-25</lastmod></url>
    </urlset>
  `);

  const items = await discoverPageIndex(feed);

  assert.equal(feed.fetch_strategy, 'page-scrape');
  assert.equal(feed.feed_url, 'https://www.anthropic.com/news');
  assert.deepEqual(items.map((item) => item.link), [
    'https://www.anthropic.com/news/claude-for-enterprise',
    'https://www.anthropic.com/news/claude-code-security',
  ]);
});

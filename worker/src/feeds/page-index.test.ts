import { assert, beforeEach, test, vi } from 'vitest';

const { mockedFetchText } = vi.hoisted(() => ({ mockedFetchText: vi.fn() }));

vi.mock('./extract', () => ({ throttledFetchText: mockedFetchText }));

import { discoverPageIndex } from './page-index';
import { getFeedDef } from './registry';

beforeEach(() => mockedFetchText.mockReset());

test('Anthropic production-shaped sitemapindex finds /news articles beyond the sixth child sitemap', async () => {
  const feed = getFeedDef('blog:anthropic');
  assert.ok(feed);
  const root = 'https://www.anthropic.com/sitemap.xml';
  const children = [
    'pages-1.xml',
    'pages-2.xml',
    'research-1.xml',
    'research-2.xml',
    'legal.xml',
    'careers.xml',
    'customers.xml',
    'news.xml',
  ].map((name) => `https://www.anthropic.com/sitemaps/${name}`);
  const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${children.map((loc) => `<sitemap><loc>${loc}</loc><lastmod>2026-08-27T06:00:00+00:00</lastmod></sitemap>`).join('')}
    </sitemapindex>`;
  const ordinaryChild = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.anthropic.com/research/model-behavior</loc><lastmod>2026-08-26</lastmod></url>
    </urlset>`;
  const newsChild = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
      <url><loc>https://www.anthropic.com/news/claude-for-enterprise</loc><lastmod>2026-08-26</lastmod></url>
      <url><loc>https://www.anthropic.com/news</loc><lastmod>2026-08-26</lastmod></url>
      <url><loc>https://www.anthropic.com/news/claude-code-security</loc><lastmod>2026-08-25</lastmod></url>
    </urlset>`;
  mockedFetchText.mockImplementation(async (url: string) => {
    if (url === root) return sitemapIndex;
    if (url === children[7]) return newsChild;
    if (children.includes(url)) return ordinaryChild;
    return null;
  });

  const items = await discoverPageIndex(feed);

  assert.equal(feed.fetch_strategy, 'page-scrape');
  assert.equal(feed.feed_url, 'https://www.anthropic.com/news');
  assert.deepEqual(items.map((item) => item.link), [
    'https://www.anthropic.com/news/claude-for-enterprise',
    'https://www.anthropic.com/news/claude-code-security',
  ]);
  assert.ok(mockedFetchText.mock.calls.length <= 13, 'sitemap traversal must stay bounded');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(new URL('./aifeeds-seo-location.conf', import.meta.url), 'utf8');

test('production SEO authority routes content archives to the Worker', () => {
  assert.match(config, /archive\(\/\.\*\)\?/);
  for (const path of ['daily', 'archive', 'i/', 'sitemap']) {
    assert.match(config, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(config, /proxy_no_cache\s+1;/);
  assert.match(config, /proxy_cache_bypass\s+1;/);
});

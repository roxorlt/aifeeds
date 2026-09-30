import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetCacheHeaders } from './asset-cache-headers.ts';

test('only actual hashed JS/CSS outputs receive exact immutable rules', () => {
  const headers = buildAssetCacheHeaders([
    'assets/react-vendor-0vgmGqQF.js', 'assets/main-D7CjC8qT.js',
    'assets/bootstrap-BxXwshIm.css', 'assets/main-D7CjC8qT.js',
    'index.html', 'waterfall.html', 'sw.js.map', 'assets/main-D7CjC8qT.js.map',
    'assets/logo.svg',
  ]);
  const rules = headers.trim().split('\n\n');
  assert.equal(rules.length, 3);
  assert.ok(rules.every((rule) => rule.endsWith('Cache-Control: public, max-age=31536000, immutable')));
  assert.doesNotMatch(headers, /\*|index\.html|waterfall|\.map|logo/);
});

test('unsafe, non-hashed, and future unexpected JS/CSS names fail the build', () => {
  for (const name of ['assets/main.js', 'sw.js', 'assets/main-abc.js', '../assets/main-12345678.js', 'assets/a\nBad-12345678.css']) {
    assert.throws(() => buildAssetCacheHeaders([name]), /non-hashed/);
  }
});

test('Pages rule limit cannot silently truncate cache configuration', () => {
  assert.throws(() => buildAssetCacheHeaders(Array.from({ length: 101 }, (_, i) => `assets/chunk${i}-12345678.js`)), /100-rule/);
});

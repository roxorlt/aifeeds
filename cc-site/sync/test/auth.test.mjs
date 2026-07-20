import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalRequest,
  canonicalizeQuery,
  signRequest,
} from '../auth.mjs';

const SECRET = 'task-7-fixture-secret';
const FIXTURE_URL = new URL(
  'https://api.ai-feeds.com/api/cc-sync/page?item_id=x_list%3A42&content_hash='
    + '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);

test('Node signing exactly matches the Worker cross-runtime fixture', () => {
  assert.equal(
    buildCanonicalRequest({
      timestamp: '1753000000',
      method: 'GET',
      url: FIXTURE_URL,
      body: Buffer.alloc(0),
    }),
    '1753000000\n'
      + 'GET\n'
      + '/api/cc-sync/page\n'
      + 'content_hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      + '&item_id=x_list%3A42\n'
      + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    signRequest({
      timestamp: '1753000000',
      method: 'GET',
      url: FIXTURE_URL,
      body: Buffer.alloc(0),
      secret: SECRET,
    }),
    '6453e5535a85f8d9e403e2ab5cfec0df97a597afdcd0d105fb8f43e0dae83909',
  );
});

test('query canonicalization sorts decoded pairs and uses strict RFC3986 encoding', () => {
  const url = new URL(
    'https://api.ai-feeds.com/api/cc-sync/page'
      + '?z=&a=space+value&a=%21%27%28%29%2A&a=space%20value&%C3%A9=%2F',
  );
  assert.equal(
    canonicalizeQuery(url),
    'a=%21%27%28%29%2A&a=space%20value&a=space%20value&z=&%C3%A9=%2F',
  );
});

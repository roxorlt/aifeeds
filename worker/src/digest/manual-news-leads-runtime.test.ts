import { describe, expect, test } from 'vitest';

import { extractManualNewsEvidence } from './manual-news-leads-runtime';

describe('manual lead evidence extraction', () => {
  test('keeps an explicit source publication time separate from retrieval time', async () => {
    const evidence = await extractManualNewsEvidence({
      url: 'https://www.anthropic.com/news/example',
      content_type: 'text/html',
      body: '<html><head><title>Supported output provenance</title><meta property="article:published_time" content="2026-08-10T09:30:00-04:00"></head><body>Scope is limited to supported products.</body></html>',
      redirects: 0,
      bytes: 220,
    }, undefined, 1234);

    expect(evidence).toMatchObject({
      source_type: 'official_primary',
      published_at: '2026-08-10T13:30:00.000Z',
      retrieved_at: 1234,
    });
  });

  test('does not invent a publication time when the source and search hint omit it', async () => {
    const evidence = await extractManualNewsEvidence({
      url: 'https://www.axios.com/example', content_type: 'text/html',
      body: '<title>Report</title><p>No machine-readable publication time.</p>', redirects: 0, bytes: 70,
    }, undefined, 1234);
    expect(evidence?.published_at).toBeNull();
  });
});

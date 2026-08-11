import { describe, expect, test, vi } from 'vitest';

import { fetchPublicDocument, validatePublicHttpUrl } from './safe-url-fetch';

describe('safe manual-news document fetch', () => {
  test('accepts only credential-free HTTP(S) URLs on standard ports', () => {
    expect(validatePublicHttpUrl('https://example.com/news').toString()).toBe('https://example.com/news');
    for (const unsafe of [
      'file:///etc/passwd',
      'https://user:pass@example.com/news',
      'https://example.com:8443/news',
      'http://localhost/news',
      'http://127.0.0.1/news',
      'http://[::1]/news',
      'http://[::ffff:7f00:1]/news',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      expect(() => validatePublicHttpUrl(unsafe), unsafe).toThrow(/unsafe_url/);
    }
  });

  test('rejects private DNS answers and DNS-rebinding-shaped answer changes', async () => {
    await expect(fetchPublicDocument('https://private.example/story', {
      resolveHost: async () => ['10.0.0.8'],
      fetcher: vi.fn(),
    })).rejects.toThrow(/unsafe_resolved_address/);

    let calls = 0;
    const fetcher = vi.fn(async () => new Response('<p>never</p>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    await expect(fetchPublicDocument('https://flip.example/story', {
      resolveHost: async () => (++calls === 1 ? ['93.184.216.34'] : ['93.184.216.35']),
      fetcher,
    })).rejects.toThrow(/dns_rebinding_detected/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('validates every redirect before following and never fetches a private target', async () => {
    const fetched: string[] = [];
    await expect(fetchPublicDocument('https://public.example/story', {
      resolveHost: async (hostname) => hostname === 'public.example'
        ? ['93.184.216.34']
        : ['127.0.0.1'],
      fetcher: async (input) => {
        fetched.push(String(input));
        return new Response(null, { status: 302, headers: { Location: 'http://internal.example/admin' } });
      },
    })).rejects.toThrow(/unsafe_resolved_address/);
    expect(fetched).toEqual(['https://public.example/story']);
  });

  test('enforces content type, response size, and redirect count limits', async () => {
    const resolveHost = async () => ['93.184.216.34'];
    await expect(fetchPublicDocument('https://example.com/image', {
      resolveHost,
      fetcher: async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }),
    })).rejects.toThrow(/unsupported_content_type/);

    await expect(fetchPublicDocument('https://example.com/huge', {
      resolveHost,
      maxBytes: 4,
      fetcher: async () => new Response('12345', { headers: { 'Content-Type': 'text/plain' } }),
    })).rejects.toThrow(/response_too_large/);

    await expect(fetchPublicDocument('https://example.com/loop', {
      resolveHost,
      maxRedirects: 1,
      fetcher: async (input) => new Response(null, {
        status: 302,
        headers: { Location: new URL('/next', String(input)).toString() },
      }),
    })).rejects.toThrow(/too_many_redirects/);
  });
});

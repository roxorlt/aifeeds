import fs from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  fileURLToPath(new NodeURL('./index.ts', import.meta.url)),
  'utf8',
);

describe('public media transport contract', () => {
  test('/img transforms only still images and preserves video Range', () => {
    const start = source.indexOf('async function handleImageProxy');
    const end = source.indexOf('// ─── Bot UA', start);
    const handler = source.slice(start, end);

    expect(handler).toMatch(/const isVideo = targetUrl\.hostname === 'video\.twimg\.com'/);
    expect(handler).toMatch(/if \(isVideo && rangeHeader\) upstreamHeaders\['Range'\] = rangeHeader/);
    expect(handler).toMatch(/const cfOptions:[\s\S]*?= isVideo\s*\? \{\}/);
    expect(handler).toMatch(/status: upstream\.status/);
    expect(handler).toMatch(/Content-Range/);
    expect(handler).toMatch(/redirect:\s*'manual'/);
    expect(handler).toMatch(/buildImageProxyCacheKey\(url, currentTarget,/);
    expect(handler).toMatch(/isAllowedImageProxyTarget\(redirected\)/);
    expect(handler).not.toMatch(/redirect:\s*'follow'/);
  });

  test('/img validates HTTPS and the host allowlist again on every redirect hop', () => {
    const allowlistStart = source.indexOf('const ALLOWED_IMG_HOSTS');
    const handlerEnd = source.indexOf('// ─── Bot UA', allowlistStart);
    const contract = source.slice(allowlistStart, handlerEnd);

    expect(contract).toMatch(/target\.protocol === 'https:'/);
    expect(contract).toMatch(/MAX_IMAGE_REDIRECTS/);
    expect(contract).toMatch(/new URL\(location, currentTarget\)/);
    expect(contract).toMatch(/return new Response\('redirect host not allowed'/);
  });

  test('/r keeps immutable still assets and byte-range audio/video seek', () => {
    const start = source.indexOf('function parseSingleByteRange');
    const handlerAndHelpers = source.slice(start);

    expect(handlerAndHelpers).toMatch(/request\.headers\.get\('Range'\)/);
    expect(handlerAndHelpers).toMatch(/READMES\.get\(key, \{ range: rangeParsed \}\)/);
    expect(handlerAndHelpers).toMatch(/status: 206/);
    expect(handlerAndHelpers).toMatch(/Content-Range/);
    expect(handlerAndHelpers).toMatch(/Accept-Ranges/);
    expect(handlerAndHelpers).toMatch(/Timing-Allow-Origin', '\*'/);
    expect(handlerAndHelpers).toMatch(/max-age=31536000, immutable/);
  });
});

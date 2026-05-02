// Phase 1 POC — verify CF Browser Rendering can fetch a PH product page
// past the Cloudflare turnstile.
//
// Pass criteria (per design doc § 3.3):
//   - HTML 不是 challenge 页（无 "Just a moment"）
//   - JSON-LD blocks ≥ 4
//   - 单页耗时 < 8s
//
// Trigger: GET /poc/ph?slug=zed
// 临时无鉴权，方便 Phase 1 验收。Phase 2 落地后 route 直接删除。
// 风险：陌生人 hit 一次烧 CF Browser ~5 秒（月度 10h 充足，单次成本忽略）。

import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import type { Env } from '../index';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 15_000;
const POST_NAV_WAIT_MS = 8_000;

export async function handlePhPoc(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || 'zed';
  if (!env.BROWSER) {
    return jsonError('BROWSER binding missing — check wrangler.toml', 500);
  }

  const target = `https://www.producthunt.com/products/${slug}`;
  const t0 = Date.now();

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_UA);

    const navStart = Date.now();
    let response;
    try {
      response = await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (e) {
      return jsonError(`page.goto failed: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
    const navTime = Date.now() - navStart;

    const status = response?.status() ?? null;
    const finalUrl = page.url();

    // First snapshot — likely turnstile if PH bot-checks us
    const html1 = await page.content();
    const isTurnstile1 = isChallengePage(html1);

    // If challenge present, give it a moment to auto-solve (CF turnstile
    // sometimes resolves silently for known clients).
    let waitTime = 0;
    if (isTurnstile1) {
      const ws = Date.now();
      try {
        await page.waitForSelector('h1', { timeout: POST_NAV_WAIT_MS });
      } catch {
        /* timeout — keep going, we'll record final state */
      }
      waitTime = Date.now() - ws;
    }

    const html2 = await page.content();
    const isTurnstile2 = isChallengePage(html2);
    const title = await page.title();

    const ldJsonBlocks = countLdJson(html2);
    const ogDesc = extractMeta(html2, 'og:description');
    const ogTitle = extractMeta(html2, 'og:title');
    const hasNextF = html2.includes('self.__next_f.push');

    const totalTime = Date.now() - t0;

    const passes = {
      not_turnstile: !isTurnstile2,
      ldjson_4_or_more: ldJsonBlocks >= 4,
      time_under_8s: totalTime < 8_000,
      has_og_title: !!ogTitle,
    };
    const allPass = Object.values(passes).every((v) => v);

    return jsonResponse({
      slug,
      target,
      finalUrl,
      status,
      title,
      ogTitle,
      ogDescPreview: ogDesc?.slice(0, 200) ?? null,
      isTurnstileFirstFetch: isTurnstile1,
      isTurnstileFinal: isTurnstile2,
      hasNextFStream: hasNextF,
      ldJsonBlocks,
      htmlSizeBytes: html2.length,
      timings: {
        nav: navTime,
        postNavWait: waitTime,
        total: totalTime,
      },
      passes,
      allPass,
    });
  } catch (e) {
    return jsonError(`puppeteer error: ${e instanceof Error ? e.message : String(e)}`, 500);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function countLdJson(html: string): number {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>/g;
  return (html.match(re) || []).length;
}

function extractMeta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta\\s+property="${prop}"\\s+content="([^"]*)"`);
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isChallengePage(html: string): boolean {
  return (
    html.includes('challenges.cloudflare.com') ||
    /<title[^>]*>Just a moment/i.test(html) ||
    /Enable JavaScript and cookies to continue/i.test(html)
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

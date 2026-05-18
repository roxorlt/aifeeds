// CF Browser Rendering: 拿 arxiv.org/html 论文 figure URL
//
// 直接 fetch arxiv.org 时 CF Workers 出口 IP 被 anti-scraping:img src 全替换 11×14 px
// data:image/png placeholder。用真 puppeteer headless Chrome 拿真 figure URL。
//
// 配额:Workers Paid 自带 10h/月;HF 50 paper × ~5s × 30 = 2h/月,充足。
//
// 失败容错:返空数组,上层 ar5iv.ts 继续走 ar5iv fallback / HF social-thumbnail 兜底。

import puppeteer from '@cloudflare/puppeteer';
import type { Env } from '../index';

const ARXIV_HTML_BASE = 'https://arxiv.org/html';
const PUPPETEER_TIMEOUT_MS = 30_000;

export async function fetchFiguresViaPuppeteer(
  env: Env,
  arxivId: string,
): Promise<string[]> {
  if (!env.BROWSER) {
    console.warn(`[hf-paper:figure-puppeteer] ${arxivId}: BROWSER binding missing, skip`);
    return [];
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // 不等 networkidle(arxiv.org/html 可能持续 load MathJax / fonts,domcontentloaded 即可拿 figure URL)
    await page.goto(`${ARXIV_HTML_BASE}/${arxivId}`, {
      waitUntil: 'domcontentloaded',
      timeout: PUPPETEER_TIMEOUT_MS,
    });

    // 浏览器内执行 — 拿到的 img.src 是 absolute URL(arxiv.org/html/<id>v<N>/x1.png)
    // naturalWidth/naturalHeight 是真实渲染尺寸,可直接做 quality gate
    const figureUrls = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs
        .filter((img) => {
          const src = img.src;
          if (!src || src.startsWith('data:')) return false;
          if (src.includes('/static/browse/')) return false;       // arxiv chrome
          if (src.endsWith('.svg')) return false;
          // naturalWidth/Height 在 page eval 内立即可用(图已加载完 dom)
          if (img.naturalWidth < 300 || img.naturalHeight < 200) return false;
          return true;
        })
        .map((img) => img.src);
    });

    console.log(`[hf-paper:figure-puppeteer] ${arxivId}: ${figureUrls.length} figures via puppeteer`);
    return figureUrls;
  } catch (e) {
    console.error(`[hf-paper:figure-puppeteer] ${arxivId} exception`, e);
    return [];
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

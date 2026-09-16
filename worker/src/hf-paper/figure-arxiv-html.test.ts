import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  extractArxivFigureCandidates,
  fetchFirstFigureFromArxivHtml,
  probeImageDimensions,
} from './figure-arxiv-html';

// 真实 arXiv 网页版(LaTeXML)结构裁剪而来,见夹具文件头注释。
const FIXTURE = readFileSync(
  fileURLToPath(new NodeURL('./__fixtures__/arxiv-html-figures.html', import.meta.url)),
  'utf-8',
);

// ── 二进制夹具:自己拼 PNG / JPEG / GIF 头,尺寸与字节数可控 ──

function makePng(width: number, height: number, byteLen = 20000, colorType = 6, paletteSize?: number): Uint8Array {
  const u = new Uint8Array(Math.max(byteLen, 64));
  u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(u.buffer);
  dv.setUint32(8, 13);                                  // IHDR chunk length
  u.set([0x49, 0x48, 0x44, 0x52], 12);                  // "IHDR"
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  u[24] = 8;                                            // bit depth
  u[25] = colorType;                                    // 3 = paletted
  if (colorType === 3 && paletteSize !== undefined) {
    dv.setUint32(33, paletteSize * 3);                  // PLTE chunk length
    u.set([0x50, 0x4c, 0x54, 0x45], 37);                // "PLTE"
  }
  return u;
}

function makeJpeg(width: number, height: number, byteLen = 20000): Uint8Array {
  const u = new Uint8Array(Math.max(byteLen, 32));
  const dv = new DataView(u.buffer);
  u[0] = 0xff; u[1] = 0xd8;                             // SOI
  u[2] = 0xff; u[3] = 0xc0;                             // SOF0
  dv.setUint16(4, 17);                                  // segment length
  u[6] = 8;                                             // precision
  dv.setUint16(7, height);
  dv.setUint16(9, width);
  return u;
}

function makeGif(width: number, height: number, byteLen = 20000): Uint8Array {
  const u = new Uint8Array(Math.max(byteLen, 32));
  u.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);       // "GIF89a"
  const dv = new DataView(u.buffer);
  dv.setUint16(6, width, true);
  dv.setUint16(8, height, true);
  return u;
}

interface PutRecord { key: string; bytes: Uint8Array; contentType?: string }

function fakeEnv() {
  const puts: PutRecord[] = [];
  const env = {
    READMES: {
      async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
        puts.push({ key, bytes: value, contentType: opts?.httpMetadata?.contentType });
      },
    },
  } as unknown as { READMES: R2Bucket };
  return { env, puts };
}

/** 按 URL 派发的假 fetcher;未登记的 URL 一律 404。记录请求顺序。 */
function fakeFetcher(routes: Record<string, { bytes: Uint8Array; contentType: string } | number>) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = routes[url];
    if (hit === undefined) return new Response('nope', { status: 404 });
    if (typeof hit === 'number') return new Response('err', { status: hit });
    return new Response(hit.bytes, { status: 200, headers: { 'content-type': hit.contentType } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const RADAR = 'https://arxiv.org/html/2609.11412v1/figures/fig_radar.png';
const PIPELINE = 'https://arxiv.org/html/2609.11412v1/figures/fig_pipeline.png';

// ────────────────────────────────────────────────────────────────────
describe('extractArxivFigureCandidates', () => {
  test('真实 arXiv 网页版夹具:相对路径 resolve 成绝对地址,只留 2 张 figure 图', () => {
    const got = extractArxivFigureCandidates(FIXTURE);
    expect(got.map((c) => c.url)).toEqual([RADAR, PIPELINE]);
    expect(got.map((c) => c.figureNumber)).toEqual([1, 2]);
    expect(got.map((c) => c.order)).toEqual([1, 2]);
    expect(got[0].declaredWidth).toBe(229);
    expect(got[0].declaredHeight).toBe(225);
    expect(got[1].declaredWidth).toBe(476);
    expect(got[1].declaredHeight).toBe(318);
  });

  test('夹具里的 /static/ 站点图、svg、data: URI 一张都不进候选', () => {
    const urls = extractArxivFigureCandidates(FIXTURE).map((c) => c.url).join('|');
    expect(urls).not.toContain('/static/');
    expect(urls).not.toContain('.svg');
    expect(urls).not.toContain('data:');
  });

  test('class 含 ltx_table 的块里的图片被排除', () => {
    const html = `
      <figure class="ltx_table"><img class="ltx_graphics" src="v1/t1.png" width="900" height="500">
      <figcaption>Table 1: 表格截图</figcaption></figure>
      <figure class="ltx_figure"><img class="ltx_graphics" src="v1/f1.png" width="900" height="500">
      <figcaption>Figure 1: 真图</figcaption></figure>`;
    expect(extractArxivFigureCandidates(html).map((c) => c.url)).toEqual([
      'https://arxiv.org/html/v1/f1.png',
    ]);
  });

  test('排序按 Figure N,不按文档顺序;无编号的排最后', () => {
    const html = `
      <figure class="ltx_figure"><img src="v1/late.png"><figcaption>Figure 7: 后面的</figcaption></figure>
      <figure class="ltx_figure"><img src="v1/nocap.png"></figure>
      <figure class="ltx_figure"><img src="v1/first.png"><figcaption>Figure 2: 前面的</figcaption></figure>`;
    const got = extractArxivFigureCandidates(html);
    expect(got.map((c) => c.url.split('/').pop())).toEqual(['first.png', 'late.png', 'nocap.png']);
    expect(got.map((c) => c.figureNumber)).toEqual([2, 7, null]);
    // order 始终记文档顺序
    expect(got.map((c) => c.order)).toEqual([3, 1, 2]);
  });

  test('块内有 ltx_graphics 时只取 ltx_graphics;没有时退回块内全部 img', () => {
    const mixed = `<figure class="ltx_figure">
      <img class="ltx_centering" src="v1/deco.png"><img class="ltx_graphics" src="v1/real.png">
      <figcaption>Figure 1: x</figcaption></figure>`;
    expect(extractArxivFigureCandidates(mixed).map((c) => c.url)).toEqual([
      'https://arxiv.org/html/v1/real.png',
    ]);
    const plain = `<figure class="ltx_figure"><img src="v1/only.png"><figcaption>Figure 1: x</figcaption></figure>`;
    expect(extractArxivFigureCandidates(plain).map((c) => c.url)).toEqual([
      'https://arxiv.org/html/v1/only.png',
    ]);
  });

  test('只接受 host=arxiv.org;第三方绝对地址与重复 URL 都不进候选', () => {
    const html = `
      <figure class="ltx_figure"><img src="https://evil.example.com/a.png"><figcaption>Figure 1: a</figcaption></figure>
      <figure class="ltx_figure"><img src="https://arxiv.org/html/v1/ok.png"><figcaption>Figure 2: b</figcaption></figure>
      <figure class="ltx_figure"><img src="v1/ok.png"><figcaption>Figure 3: 同一张</figcaption></figure>`;
    expect(extractArxivFigureCandidates(html).map((c) => c.url)).toEqual([
      'https://arxiv.org/html/v1/ok.png',
    ]);
  });

  test('嵌套子图:外层 Figure N 的编号覆盖子图,图片不重复', () => {
    const html = `<figure class="ltx_figure">
      <figure class="ltx_figure"><img class="ltx_graphics" src="v1/sub_a.png"><figcaption>(a) 左</figcaption></figure>
      <figure class="ltx_figure"><img class="ltx_graphics" src="v1/sub_b.png"><figcaption>(b) 右</figcaption></figure>
      <figcaption>Figure 4: 组图</figcaption></figure>`;
    const got = extractArxivFigureCandidates(html);
    expect(got.map((c) => c.url.split('/').pop())).toEqual(['sub_a.png', 'sub_b.png']);
    expect(got.map((c) => c.figureNumber)).toEqual([4, 4]);
  });

  test('没有 figure 块的页面返回空数组', () => {
    expect(extractArxivFigureCandidates('<html><body><img src="v1/x.png"></body></html>')).toEqual([]);
    expect(extractArxivFigureCandidates('')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('probeImageDimensions', () => {
  test('PNG / JPEG / GIF 都能读出尺寸,非 paletted PNG 的 palette 为 null', () => {
    expect(probeImageDimensions(makePng(800, 600))).toEqual({ width: 800, height: 600, paletteSize: null });
    expect(probeImageDimensions(makeJpeg(640, 480))).toEqual({ width: 640, height: 480, paletteSize: null });
    expect(probeImageDimensions(makeGif(320, 240))).toEqual({ width: 320, height: 240, paletteSize: null });
  });
  test('paletted PNG 读得出 PLTE 色数', () => {
    expect(probeImageDimensions(makePng(800, 600, 20000, 3, 24))).toEqual({
      width: 800, height: 600, paletteSize: 24,
    });
  });
  test('非图片字节返回 null', () => {
    expect(probeImageDimensions(new Uint8Array(100))).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('fetchFirstFigureFromArxivHtml — html 模式', () => {
  test('传入 HTML 时走候选,横图(score 100)胜过方图', async () => {
    const { env, puts } = fakeEnv();
    const { fetcher, calls } = fakeFetcher({
      [RADAR]: { bytes: makePng(900, 890), contentType: 'image/png' },       // 近方形 → 60 分
      [PIPELINE]: { bytes: makePng(1400, 900), contentType: 'image/png' },   // 横图 → 100 分
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.11412', { html: FIXTURE, fetcher });
    expect(got).not.toBeNull();
    expect(got!.raw_url).toBe(PIPELINE);
    expect(got!.width).toBe(1400);
    expect(got!.picked_index).toBe(2);
    expect(got!.r2_url).toMatch(/^\/r\/hf\/[0-9a-f]{64}\.png$/);
    expect(puts).toHaveLength(1);
    expect(puts[0].contentType).toBe('image/png');
    // 绝不去拼 x1.png
    expect(calls.some((u) => u.includes('/x1.png'))).toBe(false);
    expect(calls).toEqual([RADAR, PIPELINE]);
  });

  test('JPEG 候选被接受,R2 key 后缀与 content-type 跟着变', async () => {
    const jpegUrl = 'https://arxiv.org/html/v1/figures/hero.jpg';
    const html = `<figure class="ltx_figure"><img class="ltx_graphics" src="v1/figures/hero.jpg">
      <figcaption>Figure 1: hero</figcaption></figure>`;
    const { env, puts } = fakeEnv();
    const { fetcher } = fakeFetcher({
      [jpegUrl]: { bytes: makeJpeg(1600, 900), contentType: 'image/jpeg' },
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.99999', { html, fetcher });
    expect(got!.raw_url).toBe(jpegUrl);
    expect(got!.r2_url).toMatch(/\.jpg$/);
    expect(got!.palette_size).toBeNull();
    expect(puts[0].contentType).toBe('image/jpeg');
  });

  test('GIF 候选同样被接受', async () => {
    const gifUrl = 'https://arxiv.org/html/v1/figures/anim.gif';
    const html = `<figure class="ltx_figure"><img src="v1/figures/anim.gif"><figcaption>Figure 1: g</figcaption></figure>`;
    const { env, puts } = fakeEnv();
    const { fetcher } = fakeFetcher({ [gifUrl]: { bytes: makeGif(1200, 800), contentType: 'image/gif' } });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.99998', { html, fetcher });
    expect(got!.r2_url).toMatch(/\.gif$/);
    expect(puts[0].contentType).toBe('image/gif');
  });

  test('图标尺寸的候选被 gate 拒掉 → 换下一张', async () => {
    const { env } = fakeEnv();
    const { fetcher } = fakeFetcher({
      [RADAR]: { bytes: makePng(120, 120), contentType: 'image/png' },       // icon,maxDim < 300
      [PIPELINE]: { bytes: makePng(1400, 900), contentType: 'image/png' },
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.11412', { html: FIXTURE, fetcher });
    expect(got!.raw_url).toBe(PIPELINE);
  });

  test('大尺寸纯色 logo(palette 少)被 gate 拒', async () => {
    const { env } = fakeEnv();
    const { fetcher } = fakeFetcher({
      [RADAR]: { bytes: makePng(900, 890, 20000, 3, 8), contentType: 'image/png' },
      [PIPELINE]: { bytes: makePng(1400, 900), contentType: 'image/png' },
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.11412', { html: FIXTURE, fetcher });
    expect(got!.raw_url).toBe(PIPELINE);
  });

  test('单张候选 404 不中断,继续看后面的候选', async () => {
    const { env } = fakeEnv();
    const { fetcher, calls } = fakeFetcher({
      [PIPELINE]: { bytes: makePng(1400, 900), contentType: 'image/png' },
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.11412', { html: FIXTURE, fetcher });
    expect(got!.raw_url).toBe(PIPELINE);
    expect(calls).toEqual([RADAR, PIPELINE]);
  });

  test('候选全都取不到 → 返回 null,且不回落去猜 xN', async () => {
    const { env, puts } = fakeEnv();
    const { fetcher, calls } = fakeFetcher({});
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.11412', { html: FIXTURE, fetcher });
    expect(got).toBeNull();
    expect(puts).toHaveLength(0);
    expect(calls.some((u) => u.includes('/x1.png'))).toBe(false);
  });
});

describe('fetchFirstFigureFromArxivHtml — guess 兜底', () => {
  test('HTML 里没有 figure → 回落 x1..xN 猜测循环', async () => {
    const { env } = fakeEnv();
    const { fetcher, calls } = fakeFetcher({
      'https://arxiv.org/html/2609.00001/x1.png': { bytes: makePng(1400, 900), contentType: 'image/png' },
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.00001', {
      html: '<html><body><p>纯文本论文,没有 figure 块</p></body></html>',
      fetcher,
    });
    expect(got!.raw_url).toBe('https://arxiv.org/html/2609.00001/x1.png');
    expect(got!.picked_index).toBe(1);
    expect(calls).toEqual(['https://arxiv.org/html/2609.00001/x1.png']);
  });

  test('完全不传 HTML 时行为与老版一致(x1 404 即停)', async () => {
    const { env } = fakeEnv();
    const { fetcher, calls } = fakeFetcher({});
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.00002', { fetcher });
    expect(got).toBeNull();
    expect(calls).toEqual(['https://arxiv.org/html/2609.00002/x1.png']);
  });

  test('guess 模式下 x1 不过 gate 时继续翻 x2', async () => {
    const { env } = fakeEnv();
    const { fetcher, calls } = fakeFetcher({
      'https://arxiv.org/html/2609.00003/x1.png': { bytes: makePng(100, 100), contentType: 'image/png' },
      'https://arxiv.org/html/2609.00003/x2.png': { bytes: makePng(1400, 900), contentType: 'image/png' },
    });
    const got = await fetchFirstFigureFromArxivHtml(env, '2609.00003', { fetcher });
    expect(got!.picked_index).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('没有 R2 binding 时直接返回 null,一次外呼都不发', async () => {
    const { fetcher, calls } = fakeFetcher({});
    const got = await fetchFirstFigureFromArxivHtml({} as { READMES?: R2Bucket }, '2609.00004', { fetcher });
    expect(got).toBeNull();
    expect(calls).toEqual([]);
  });
});

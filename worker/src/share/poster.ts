// PR5 share poster 渲染：SVG → PNG（resvg-wasm + Noto Sans SC 子集）
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 4

import { initWasm, Resvg } from '@resvg/resvg-wasm';
// @ts-expect-error wasm 由 wrangler 默认 rule 导入为 WebAssembly.Module
import resvgWasmModule from '@resvg/resvg-wasm/index_bg.wasm';
// @ts-expect-error woff2 由 wrangler.toml [[rules]] type=Data 导入为 ArrayBuffer
import notoSansScFont from './assets/noto-sc-medium.woff2';

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await initWasm(resvgWasmModule as WebAssembly.Module);
  initialized = true;
}

export async function renderSvgToPng(svg: string): Promise<Uint8Array> {
  await ensureInit();
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [new Uint8Array(notoSansScFont as ArrayBuffer)],
      defaultFontFamily: 'Noto Sans SC',
      loadSystemFonts: false,
    },
    fitTo: { mode: 'original' },
  });
  return resvg.render().asPng();
}

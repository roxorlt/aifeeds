// 外挂 eval:测 figure-pdf.ts extractor 在大样本 PDF 上的命中率
//
// 跑法:
//   cd worker
//   HF_READ=hf_xxx npx tsx scripts/eval-figure-pdf.ts --per-source 30
//
// 流程:
//   1. 拉 5 source × per-source paper id 列表(hf-daily / cs.CV / cs.CL / cs.LG / stat.ML)
//   2. 串行 fetch PDF binary 到本地 tmp + 跑 pdfimages 拿 ground truth + 跑 extractor
//   3. aggregate stats → markdown report
//   4. cleanup tmp PDF + first-extracted-figure 保留供视觉抽检
//
// 依赖:本地 brew install poppler(提供 pdfimages CLI)
//      npx tsx(zero-install)
//      worker dep:fflate(figure-pdf.ts import)

import { extractImagesFromPdf } from '../src/hf-paper/figure-pdf';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const PDF_DIR = join(tmpdir(), 'eval-pdfs');
const FIGURES_DIR = join(tmpdir(), 'eval-figures');
const HF_READ = process.env.HF_READ || '';

interface PaperEval {
  source: string;
  arxiv_id: string;
  pdf_size: number;
  // ground truth (pdfimages)
  gt_total: number;
  gt_by_codec: Record<string, number>;
  // our extractor
  ex_total: number;
  ex_total_image_xobjects: number;
  ex_by_codec: Record<string, number>;
  ex_skipped: Record<string, number>;
  ex_duration_ms: number;
  hit_rate: number;
  first_extracted_path?: string;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ────────────────────────────────────────────────────────────────────
// paper id sources
// ────────────────────────────────────────────────────────────────────

async function fetchHfDailyIds(n: number): Promise<string[]> {
  const ids = new Set<string>();
  // 拉最近 30 天 daily 聚合 unique paper id
  for (let day = 0; day < 30 && ids.size < n; day++) {
    const date = new Date(Date.now() - day * 86400_000).toISOString().slice(0, 10);
    try {
      const r = await fetch(`https://huggingface.co/api/daily_papers?date=${date}`, {
        headers: HF_READ ? { Authorization: `Bearer ${HF_READ}` } : {},
      });
      if (!r.ok) continue;
      const list = (await r.json()) as Array<{ paper?: { id?: string } }>;
      for (const x of list) {
        if (x.paper?.id) ids.add(x.paper.id);
        if (ids.size >= n) break;
      }
    } catch (e) {
      console.warn(`  hf-daily ${date} fetch fail`, (e as Error).message);
    }
    await sleep(200);
  }
  return Array.from(ids).slice(0, n);
}

async function fetchArxivCategoryIds(category: string, n: number): Promise<string[]> {
  // arxiv API rate limit 3 sec/query,1 query 够
  try {
    const r = await fetch(
      `http://export.arxiv.org/api/query?search_query=cat:${category}` +
      `&start=0&max_results=${n}&sortBy=submittedDate&sortOrder=descending`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-eval/1.0)' } },
    );
    if (!r.ok) {
      console.warn(`  arxiv cat=${category} HTTP ${r.status}`);
      return [];
    }
    const xml = await r.text();
    const ids = new Set<string>();
    const idRe = /<id>http:\/\/arxiv\.org\/abs\/([\d.]+)(?:v\d+)?<\/id>/g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(xml)) !== null) ids.add(m[1]);
    return Array.from(ids).slice(0, n);
  } catch (e) {
    console.warn(`  arxiv cat=${category} exception`, (e as Error).message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// per-paper eval
// ────────────────────────────────────────────────────────────────────

async function fetchPdf(arxivId: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(`https://arxiv.org/pdf/${arxivId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-eval/1.0)' },
    });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function runPdfimages(pdfPath: string): { total: number; by_codec: Record<string, number> } {
  try {
    const out = execSync(`pdfimages -list "${pdfPath}"`, {
      encoding: 'utf8',
      timeout: 30000,
    });
    // pdfimages -list output 列(按 poppler 26.x):
    //   page num type width height color comp bpc enc interp ...
    const lines = out.split('\n').slice(2);  // skip 2 header lines
    let total = 0;
    const byCodec: Record<string, number> = {};
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const type = parts[2];   // image / mask / smask
      if (type !== 'image') continue;
      const enc = parts[8];    // jpeg / image (= raw FlateDecode) / ccitt / jpx / jbig2 / ...
      total++;
      byCodec[enc] = (byCodec[enc] || 0) + 1;
    }
    return { total, by_codec: byCodec };
  } catch (e) {
    return { total: 0, by_codec: { _error: 1 } };
  }
}

async function evalPaper(source: string, arxivId: string): Promise<PaperEval> {
  const base: PaperEval = {
    source, arxiv_id: arxivId, pdf_size: 0,
    gt_total: 0, gt_by_codec: {},
    ex_total: 0, ex_total_image_xobjects: 0,
    ex_by_codec: {}, ex_skipped: {}, ex_duration_ms: 0, hit_rate: 0,
  };
  const pdfBytes = await fetchPdf(arxivId);
  if (!pdfBytes) {
    base.error = 'fetch_pdf_fail';
    return base;
  }
  if (pdfBytes.length < 200 || !(pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50)) {
    // not %PDF
    base.error = `not_pdf_size_${pdfBytes.length}`;
    return base;
  }
  base.pdf_size = pdfBytes.length;

  // ground truth
  const pdfPath = join(PDF_DIR, `${arxivId}.pdf`);
  writeFileSync(pdfPath, pdfBytes);
  const gt = runPdfimages(pdfPath);
  base.gt_total = gt.total;
  base.gt_by_codec = gt.by_codec;

  // extractor
  try {
    const { images, stats } = extractImagesFromPdf(pdfBytes);
    base.ex_total = stats.extracted;
    base.ex_total_image_xobjects = stats.total_image_xobjects;
    base.ex_by_codec = stats.by_codec;
    base.ex_skipped = stats.skipped;
    base.ex_duration_ms = stats.duration_ms;
    base.hit_rate = gt.total > 0 ? stats.extracted / gt.total : 0;

    if (images.length > 0) {
      const figPath = join(FIGURES_DIR, `${arxivId}.first.${images[0].ext}`);
      writeFileSync(figPath, images[0].bytes);
      base.first_extracted_path = figPath;
    }
  } catch (e) {
    base.error = `extractor_exception_${(e as Error).message?.slice(0, 50)}`;
  }
  return base;
}

// ────────────────────────────────────────────────────────────────────
// aggregation + report
// ────────────────────────────────────────────────────────────────────

function generateReport(evals: PaperEval[]): string {
  const okEvals = evals.filter((e) => !e.error);
  const errEvals = evals.filter((e) => e.error);

  const totalGtImages = okEvals.reduce((s, e) => s + e.gt_total, 0);
  const totalExImages = okEvals.reduce((s, e) => s + e.ex_total, 0);
  const totalDuration = okEvals.reduce((s, e) => s + e.ex_duration_ms, 0);
  const paperWithAny = okEvals.filter((e) => e.ex_total > 0).length;
  const paperWithGt = okEvals.filter((e) => e.gt_total > 0).length;

  // by source aggregation
  const bySource: Record<string, { gt: number; ex: number; n: number; paperWithAny: number }> = {};
  for (const e of okEvals) {
    if (!bySource[e.source]) bySource[e.source] = { gt: 0, ex: 0, n: 0, paperWithAny: 0 };
    bySource[e.source].gt += e.gt_total;
    bySource[e.source].ex += e.ex_total;
    bySource[e.source].n++;
    if (e.ex_total > 0) bySource[e.source].paperWithAny++;
  }

  // ground truth codec 汇总
  const gtCodecSum: Record<string, number> = {};
  for (const e of okEvals) {
    for (const [k, v] of Object.entries(e.gt_by_codec)) {
      gtCodecSum[k] = (gtCodecSum[k] || 0) + v;
    }
  }

  // extractor codec 汇总
  const exCodecSum: Record<string, number> = {};
  for (const e of okEvals) {
    for (const [k, v] of Object.entries(e.ex_by_codec)) {
      exCodecSum[k] = (exCodecSum[k] || 0) + v;
    }
  }

  // skip 原因 top
  const skipSum: Record<string, number> = {};
  for (const e of okEvals) {
    for (const [k, v] of Object.entries(e.ex_skipped)) {
      skipSum[k] = (skipSum[k] || 0) + v;
    }
  }
  const topSkip = Object.entries(skipSum).sort((a, b) => b[1] - a[1]).slice(0, 15);

  // first figure sample
  const figureSamples = okEvals.filter((e) => e.first_extracted_path).slice(0, 20);

  const lines: string[] = [];
  lines.push(`# PDF figure extractor eval report`);
  lines.push(``);
  lines.push(`生成: ${new Date().toISOString()}`);
  lines.push(`样本: ${evals.length} paper(${okEvals.length} ok / ${errEvals.length} 错)`);
  lines.push(``);

  lines.push(`## 总命中率`);
  lines.push(``);
  lines.push(`- **Paper 任何 figure 抓到**: ${paperWithAny}/${paperWithGt} = ${(100 * paperWithAny / Math.max(paperWithGt, 1)).toFixed(1)}%`);
  lines.push(`- **Per-image 命中率**: ${totalExImages}/${totalGtImages} = ${(100 * totalExImages / Math.max(totalGtImages, 1)).toFixed(1)}%`);
  lines.push(`- **平均 extract 耗时**: ${(totalDuration / Math.max(okEvals.length, 1)).toFixed(0)} ms / paper`);
  lines.push(``);

  lines.push(`## By source`);
  lines.push(``);
  lines.push(`| Source | Paper(n) | GT images | EX images | Per-image | Paper hit |`);
  lines.push(`|--------|---------:|----------:|----------:|----------:|----------:|`);
  for (const [src, s] of Object.entries(bySource)) {
    const pi = s.gt > 0 ? (100 * s.ex / s.gt).toFixed(1) : '-';
    const ph = s.n > 0 ? (100 * s.paperWithAny / s.n).toFixed(1) : '-';
    lines.push(`| ${src} | ${s.n} | ${s.gt} | ${s.ex} | ${pi}% | ${ph}% |`);
  }
  lines.push(``);

  lines.push(`## Ground truth codec 分布(pdfimages)`);
  lines.push(``);
  lines.push(`| Codec(pdfimages enc) | Count | % |`);
  lines.push(`|----------------------|------:|---:|`);
  const gtTotal = Object.values(gtCodecSum).reduce((s, n) => s + n, 0);
  for (const [k, v] of Object.entries(gtCodecSum).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${v} | ${(100 * v / Math.max(gtTotal, 1)).toFixed(1)}% |`);
  }
  lines.push(``);

  lines.push(`## Extractor codec encounter(/Filter 字面值)`);
  lines.push(``);
  lines.push(`| /Filter | Count |`);
  lines.push(`|---------|------:|`);
  for (const [k, v] of Object.entries(exCodecSum).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push(``);

  lines.push(`## Top skip 原因`);
  lines.push(``);
  lines.push(`| 原因 | Count |`);
  lines.push(`|------|------:|`);
  for (const [k, v] of topSkip) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push(``);

  lines.push(`## 错误`);
  lines.push(``);
  for (const e of errEvals.slice(0, 20)) {
    lines.push(`- \`${e.arxiv_id}\` (${e.source}): ${e.error}`);
  }
  lines.push(``);

  lines.push(`## 视觉抽检(first extracted figure)`);
  lines.push(``);
  lines.push(`目录: ${FIGURES_DIR}/`);
  lines.push(``);
  for (const e of figureSamples) {
    lines.push(`- ${e.arxiv_id} (${e.source}) - gt:${e.gt_total} ex:${e.ex_total}: \`${e.first_extracted_path}\``);
  }
  lines.push(``);

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (k: string, fallback: string) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const perSource = parseInt(getArg('--per-source', '30'), 10);
  const sources = getArg('--sources', 'hf-daily,cs.CV,cs.CL,cs.LG,stat.ML').split(',');
  const outputPath = getArg('--output', '/tmp/eval-figure-pdf.md');
  const sleepMs = parseInt(getArg('--sleep-ms', '1500'), 10);

  console.log(`eval setup:`);
  console.log(`  per-source = ${perSource}`);
  console.log(`  sources = ${sources.join(', ')}`);
  console.log(`  output = ${outputPath}`);
  console.log(`  sleep between papers = ${sleepMs}ms`);

  // setup tmp dirs
  if (existsSync(PDF_DIR)) rmSync(PDF_DIR, { recursive: true });
  if (existsSync(FIGURES_DIR)) rmSync(FIGURES_DIR, { recursive: true });
  mkdirSync(PDF_DIR, { recursive: true });
  mkdirSync(FIGURES_DIR, { recursive: true });

  const evals: PaperEval[] = [];

  for (const source of sources) {
    console.log(`\n[${source}] 拉 paper id...`);
    let ids: string[] = [];
    if (source === 'hf-daily') ids = await fetchHfDailyIds(perSource);
    else ids = await fetchArxivCategoryIds(source, perSource);
    console.log(`  got ${ids.length} ids`);

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      process.stdout.write(`  [${i + 1}/${ids.length}] ${id}... `);
      const r = await evalPaper(source, id);
      evals.push(r);
      if (r.error) {
        process.stdout.write(`❌ ${r.error}\n`);
      } else {
        process.stdout.write(`gt:${r.gt_total} ex:${r.ex_total} (${(100 * r.hit_rate).toFixed(0)}%) ${r.ex_duration_ms}ms\n`);
      }
      await sleep(sleepMs);
    }
  }

  const report = generateReport(evals);
  writeFileSync(outputPath, report);
  console.log(`\n✅ report: ${outputPath}`);
  console.log(`figures: ${FIGURES_DIR}/ (保留供视觉抽检)`);
  console.log(`pdfs: ${PDF_DIR}/ (cleanup...)`);

  // cleanup PDF binary 但保留 figures 供 visual review
  rmSync(PDF_DIR, { recursive: true });
  console.log(`✅ cleaned up ${PDF_DIR}`);
}

main().catch((e) => {
  console.error('eval fail:', e);
  process.exit(1);
});

// Minimal PDF image extractor for HF Paper figure
//
// 论文 PDF(LaTeX 编译)image XObject 简单,~95% 是 DCTDecode / FlateDecode RGB/Gray:
//   - DCTDecode(JPEG):stream bytes 就是完整 JPEG binary,直接 write as .jpg
//   - FlateDecode(RGB / Gray):zlib decompress → reconstruct PNG header
//
// 不支持:CCITTFaxDecode / JBIG2 / JPXDecode(扫描专属,论文 < 5%)/ CMYK / Indexed
//
// 实现策略(B 版本,2026-05-18 fix):
//   1. parse PDF XRef table(traditional + XRef Stream,handle /Prev linked)
//   2. lazy decompress ObjStm 拿压缩对象(PDF 1.5+ LaTeX 编译常用)
//   3. sequential scan PDF binary 找 `<n> 0 obj` 找 image XObject(uncompressed)
//   4. dict 内 /Length / /ColorSpace 等 indirect ref → 用 XRef resolve(可能在 ObjStm 内)
//   5. extract stream by /Length(精确)or fallback endstream marker
//   6. decode by Filter,reconstruct image bytes,return
//
// CF Workers 兼容:用 Uint8Array + crypto.subtle 不依赖 Buffer/fs
// fflate 走现有 worker dep(zlibSync / inflateSync,sync 在 worker 内 OK 因 binary 小)

import { unzlibSync, zlibSync } from 'fflate';

// ────────────────────────────────────────────────────────────────────
// XRef table parsing(PDF 1.4 traditional + 1.5+ XRef Stream)
// ────────────────────────────────────────────────────────────────────

interface XRefEntryInUse {
  type: 'inUse';
  offset: number;             // byte offset of obj in PDF
  gen: number;
}
interface XRefEntryCompressed {
  type: 'compressed';
  objStmObj: number;          // ObjStm 对象号
  index: number;              // 在 ObjStm 内的 index
}
type XRefEntry = XRefEntryInUse | XRefEntryCompressed | { type: 'free' };

interface XRefTable {
  entries: Map<number, XRefEntry>;
  objStmCache: Map<number, { text: string; firstOff: number; index: Array<{ objNum: number; offset: number }> }>;
}

/**
 * find last `startxref\n<offset>\n%%EOF` in PDF
 * 返 offset = byte offset to xref section(traditional table 或 XRef Stream)
 */
function findStartXref(pdfText: string): number | null {
  // PDF spec:%%EOF 在末尾,startxref + offset 在 EOF 前
  // 搜末尾 1024 bytes
  const tail = pdfText.slice(Math.max(0, pdfText.length - 1024));
  const m = tail.match(/startxref\s+(\d+)\s+%%EOF/);
  return m ? parseInt(m[1], 10) : null;
}

function readBE(bytes: Uint8Array, off: number, size: number, defaultV = 0): number {
  if (size === 0) return defaultV;
  let v = 0;
  for (let i = 0; i < size; i++) v = (v << 8) | bytes[off + i];
  return v >>> 0;
}

/**
 * Parse XRef section starting at `offset`(traditional table 或 XRef Stream)
 * recursive 走 /Prev 链
 */
function parseXRefAt(
  offset: number,
  pdfBytes: Uint8Array,
  pdfText: string,
  table: XRefTable,
  visited: Set<number>,
): void {
  if (visited.has(offset)) return;
  visited.add(offset);

  // peek first ~6 chars 判断是 'xref' 还是 XRef Stream obj
  const head = pdfText.slice(offset, offset + 10);
  if (head.startsWith('xref')) {
    parseTraditionalXref(offset, pdfText, table, pdfBytes, visited);
  } else {
    // XRef Stream: indirect obj `<n> <g> obj\n<<dict>>\nstream\n<binary>\nendstream\nendobj`
    parseXRefStream(offset, pdfBytes, pdfText, table, visited);
  }
}

function parseTraditionalXref(
  offset: number,
  pdfText: string,
  table: XRefTable,
  pdfBytes: Uint8Array,
  visited: Set<number>,
): void {
  // 跳过 'xref\n'
  let p = offset + 'xref'.length;
  while (p < pdfText.length && (pdfText[p] === '\n' || pdfText[p] === '\r')) p++;

  // 多个 subsection:`<first> <count>\n` 后跟 count 行 `<offset> <gen> n|f\n`(20 bytes/line 含 CRLF)
  while (p < pdfText.length) {
    const headerM = pdfText.slice(p, p + 30).match(/^(\d+)\s+(\d+)\s*[\r\n]+/);
    if (!headerM) break;
    const first = parseInt(headerM[1], 10);
    const count = parseInt(headerM[2], 10);
    p += headerM[0].length;
    for (let i = 0; i < count; i++) {
      // 每 entry 固定 20 bytes:`0000000017 00000 n \n`(注意 trailing space + EOL)
      const entry = pdfText.slice(p, p + 20);
      const em = entry.match(/^(\d{10})\s+(\d{5})\s+([nf])/);
      if (em) {
        const objNum = first + i;
        // 只 set 不覆盖(linked XRef 旧条目)
        if (!table.entries.has(objNum)) {
          if (em[3] === 'n') {
            table.entries.set(objNum, { type: 'inUse', offset: parseInt(em[1], 10), gen: parseInt(em[2], 10) });
          } else {
            table.entries.set(objNum, { type: 'free' });
          }
        }
      }
      p += 20;
    }
  }

  // trailer 找 /Prev
  const trailerStart = pdfText.indexOf('trailer', p);
  if (trailerStart !== -1) {
    const trailerDict = pdfText.slice(trailerStart, trailerStart + 500);
    const prevM = trailerDict.match(/\/Prev\s+(\d+)/);
    if (prevM) {
      const prevOff = parseInt(prevM[1], 10);
      parseXRefAt(prevOff, pdfBytes, pdfText, table, visited);
    }
  }
}

function parseXRefStream(
  offset: number,
  pdfBytes: Uint8Array,
  pdfText: string,
  table: XRefTable,
  visited: Set<number>,
): void {
  // obj header `<n> <g> obj` 之后 dict + stream
  const headerM = pdfText.slice(offset, offset + 30).match(/^(\d+)\s+(\d+)\s+obj/);
  if (!headerM) return;
  const dictStart = offset + headerM[0].length;
  const dictEnd = findBalancedDictEnd(pdfText, dictStart);
  if (dictEnd === -1) return;
  const dict = pdfText.slice(dictStart, dictEnd);

  // /W [a b c]
  const wM = dict.match(/\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  if (!wM) return;
  const w0 = parseInt(wM[1], 10), w1 = parseInt(wM[2], 10), w2 = parseInt(wM[3], 10);
  const entrySize = w0 + w1 + w2;
  if (entrySize === 0) return;

  // /Index [first count ...] (默认 [0 Size])
  const indexM = dict.match(/\/Index\s*\[([^\]]+)\]/);
  let sections: Array<{ first: number; count: number }>;
  if (indexM) {
    const nums = indexM[1].split(/\s+/).filter(Boolean).map((x) => parseInt(x, 10));
    sections = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      sections.push({ first: nums[i], count: nums[i + 1] });
    }
  } else {
    const sizeM = dict.match(/\/Size\s+(\d+)/);
    const size = sizeM ? parseInt(sizeM[1], 10) : 0;
    sections = [{ first: 0, count: size }];
  }

  // /Length + 取 stream binary
  const lenM = dict.match(/\/Length\s+(\d+)/);
  if (!lenM) return;
  const streamLen = parseInt(lenM[1], 10);

  // find stream start(stream 关键字 + EOL)
  const streamKw = pdfText.indexOf('stream', dictEnd);
  if (streamKw === -1) return;
  let dataStart = streamKw + 6;
  if (pdfBytes[dataStart] === 0x0D) dataStart++;
  if (pdfBytes[dataStart] === 0x0A) dataStart++;
  const compressedStream = pdfBytes.subarray(dataStart, dataStart + streamLen);

  // /Filter /FlateDecode 必须(XRef Stream 一般 FlateDecode)
  const filterM = dict.match(/\/Filter\s+(\/\w+|\[[^\]]*\])/);
  const isFlate = filterM && filterM[1].includes('FlateDecode');
  if (!isFlate) return;

  let xrefBytes: Uint8Array;
  try {
    xrefBytes = unzlibSync(compressedStream);
  } catch {
    return;
  }

  // /DecodeParms /Predictor 12 → PNG-up filter unfilter(XRef Stream 常用)
  const predictorM = dict.match(/\/DecodeParms\s*<<[^>]*\/Predictor\s+(\d+)[^>]*>>/);
  const columnsM = dict.match(/\/DecodeParms\s*<<[^>]*\/Columns\s+(\d+)[^>]*>>/);
  if (predictorM) {
    const pred = parseInt(predictorM[1], 10);
    const columns = columnsM ? parseInt(columnsM[1], 10) : entrySize;
    if (pred >= 10 && pred <= 15) {
      xrefBytes = pngUpUnfilter(xrefBytes, columns);
    }
  }

  // 解 entries
  for (const sec of sections) {
    for (let i = 0; i < sec.count; i++) {
      const off = i * entrySize;
      if (off + entrySize > xrefBytes.length) break;
      const type = readBE(xrefBytes, off, w0, 1);  // default type=1 (in use)
      const f1 = readBE(xrefBytes, off + w0, w1, 0);
      const f2 = readBE(xrefBytes, off + w0 + w1, w2, 0);
      const objNum = sec.first + i;
      if (table.entries.has(objNum)) continue;  // 后段 XRef 不覆盖前段
      if (type === 0) {
        table.entries.set(objNum, { type: 'free' });
      } else if (type === 1) {
        table.entries.set(objNum, { type: 'inUse', offset: f1, gen: f2 });
      } else if (type === 2) {
        table.entries.set(objNum, { type: 'compressed', objStmObj: f1, index: f2 });
      }
    }
  }

  // /Prev recurse
  const prevM = dict.match(/\/Prev\s+(\d+)/);
  if (prevM) {
    parseXRefAt(parseInt(prevM[1], 10), pdfBytes, pdfText, table, visited);
  }
}

/**
 * PNG-up filter unfilter (Predictor 12-15)
 * Each row prefixed by 1 byte filter type;rebuild raw row from prev row
 * 简化:只 handle Predictor 12(PNG up filter,常见 XRef Stream)
 */
function pngUpUnfilter(filtered: Uint8Array, columns: number): Uint8Array {
  const rowSize = columns + 1;  // +1 for filter byte
  const rows = Math.floor(filtered.length / rowSize);
  const out = new Uint8Array(rows * columns);
  const prevRow = new Uint8Array(columns);
  for (let r = 0; r < rows; r++) {
    const filterType = filtered[r * rowSize];
    const rawSrc = r * rowSize + 1;
    const rawDst = r * columns;
    if (filterType === 2) {
      // PNG up
      for (let c = 0; c < columns; c++) {
        out[rawDst + c] = (filtered[rawSrc + c] + prevRow[c]) & 0xff;
      }
    } else if (filterType === 0) {
      // none
      for (let c = 0; c < columns; c++) out[rawDst + c] = filtered[rawSrc + c];
    } else {
      // 其他 filter type(sub/avg/paeth)简化用 none 处理 — 可能不准但不 crash
      for (let c = 0; c < columns; c++) out[rawDst + c] = filtered[rawSrc + c];
    }
    prevRow.set(out.subarray(rawDst, rawDst + columns));
  }
  return out;
}

/**
 * find balanced `>>` 给 dict 起 `<<` 后,返 first `>>` after matched `<<` 的 offset+2
 */
function findBalancedDictEnd(text: string, start: number): number {
  // start 应该指向 `<<` 之后,或 dict 第一个字符
  // 简化:扫 << 和 >> 配平
  let depth = 1;
  let i = start;
  while (i < text.length - 1) {
    if (text[i] === '<' && text[i + 1] === '<') { depth++; i += 2; }
    else if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      if (depth === 0) return i + 2;
      i += 2;
    } else { i++; }
  }
  return -1;
}

/**
 * Resolve obj N → return its body text(从 `<n> 0 obj` 后到 `endobj` 前)
 * 处理两种情况:
 *   - inUse: 用 XRef offset 直接 slice
 *   - compressed: 拿 ObjStm,decompress(lazy),从 index 找 obj
 */
function resolveObj(table: XRefTable, objNum: number, pdfBytes: Uint8Array, pdfText: string): string | null {
  const entry = table.entries.get(objNum);
  if (!entry) return null;
  if (entry.type === 'free') return null;
  if (entry.type === 'inUse') {
    // pdfText[offset] 应该是 `<n> 0 obj` 起始
    const slice = pdfText.slice(entry.offset, entry.offset + 100000);
    const m = slice.match(/^\d+\s+\d+\s+obj\s*([\s\S]*?)\s*(?:stream|endobj)/);
    return m ? m[1] : null;
  }
  // compressed: 拿 ObjStm
  if (entry.type === 'compressed') {
    const stm = getObjStm(table, entry.objStmObj, pdfBytes, pdfText);
    if (!stm) return null;
    const item = stm.index[entry.index];
    if (!item) return null;
    // obj 内容从 stm.firstOff + item.offset 开始,到 next item 起或 stream 末
    const nextOff = (entry.index + 1 < stm.index.length)
      ? stm.firstOff + stm.index[entry.index + 1].offset
      : stm.text.length;
    return stm.text.slice(stm.firstOff + item.offset, nextOff).trim();
  }
  return null;
}

function getObjStm(table: XRefTable, objStmObjNum: number, pdfBytes: Uint8Array, pdfText: string): XRefTable['objStmCache'] extends Map<unknown, infer V> ? V : never | null {
  const cached = table.objStmCache.get(objStmObjNum);
  if (cached) return cached;

  const entry = table.entries.get(objStmObjNum);
  if (!entry || entry.type !== 'inUse') return null as never;

  const slice = pdfText.slice(entry.offset, entry.offset + 100);
  const headerM = slice.match(/^\d+\s+\d+\s+obj/);
  if (!headerM) return null as never;
  const dictStart = entry.offset + headerM[0].length;
  const dictEnd = findBalancedDictEnd(pdfText, dictStart);
  if (dictEnd === -1) return null as never;
  const dict = pdfText.slice(dictStart, dictEnd);

  const nM = dict.match(/\/N\s+(\d+)/);
  const firstM = dict.match(/\/First\s+(\d+)/);
  const lenM = dict.match(/\/Length\s+(\d+)/);
  if (!nM || !firstM || !lenM) return null as never;
  const n = parseInt(nM[1], 10);
  const first = parseInt(firstM[1], 10);
  const len = parseInt(lenM[1], 10);

  const streamKw = pdfText.indexOf('stream', dictEnd);
  if (streamKw === -1) return null as never;
  let dataStart = streamKw + 6;
  if (pdfBytes[dataStart] === 0x0D) dataStart++;
  if (pdfBytes[dataStart] === 0x0A) dataStart++;

  let inflated: Uint8Array;
  try {
    inflated = unzlibSync(pdfBytes.subarray(dataStart, dataStart + len));
  } catch {
    return null as never;
  }

  const text = new TextDecoder('latin1').decode(inflated);
  // header `<num1> <off1> <num2> <off2> ...` (n pairs),separator whitespace
  const headerText = text.slice(0, first);
  const nums = headerText.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 10));
  const index: Array<{ objNum: number; offset: number }> = [];
  for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
    index.push({ objNum: nums[i * 2], offset: nums[i * 2 + 1] });
  }
  const result = { text, firstOff: first, index };
  table.objStmCache.set(objStmObjNum, result);
  return result;
}

/**
 * Resolve `<n> 0 R` indirect ref to integer value
 * 用于 /Length 12 0 R 这种情况
 */
function resolveIntRef(table: XRefTable, refStr: string, pdfBytes: Uint8Array, pdfText: string): number | null {
  const m = refStr.match(/(\d+)\s+\d+\s+R/);
  if (!m) return null;
  const objData = resolveObj(table, parseInt(m[1], 10), pdfBytes, pdfText);
  if (!objData) return null;
  const nM = objData.match(/^\s*(\d+)/);
  return nM ? parseInt(nM[1], 10) : null;
}

function buildXRefTable(pdfBytes: Uint8Array, pdfText: string): XRefTable | null {
  const startXref = findStartXref(pdfText);
  if (startXref === null) return null;
  const table: XRefTable = {
    entries: new Map(),
    objStmCache: new Map(),
  };
  parseXRefAt(startXref, pdfBytes, pdfText, table, new Set());
  return table;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface ExtractedImage {
  codec: 'DCTDecode' | 'FlateDecode';
  bytes: Uint8Array;           // image binary ready to write(JPEG / PNG)
  ext: 'jpg' | 'png';
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  obj_id: string;              // PDF object id (e.g. "12 0")
}

export interface ExtractStats {
  total_image_xobjects: number;
  extracted: number;
  // codec 分布(包括 extract 成功 + skip)
  by_codec: Record<string, number>;
  // skip 原因分布
  skipped: Record<string, number>;
  duration_ms: number;
}

export interface ExtractResult {
  images: ExtractedImage[];
  stats: ExtractStats;
}

const TD = new TextDecoder('latin1');                  // 用 latin1 让 binary bytes 1:1 映射 char
const TE = new TextEncoder();

export function extractImagesFromPdf(
  pdfBytes: Uint8Array,
  opts: { max?: number; debug?: boolean } = {},
): ExtractResult {
  const t0 = Date.now();
  const stats: ExtractStats = {
    total_image_xobjects: 0,
    extracted: 0,
    by_codec: {},
    skipped: {},
    duration_ms: 0,
  };
  const images: ExtractedImage[] = [];

  // 全 PDF 转 latin1 string 方便正则 + indexOf,但 stream binary 仍用 byte offset 切
  // (latin1 字符 1:1 byte,length 跟 byte 长度一致,offset 直接通用)
  const pdfText = TD.decode(pdfBytes);

  // ─── B 版本核心:parse XRef table(traditional + XRef Stream + ObjStm)─
  // 用于 resolve indirect ref(/Length 12 0 R / ICCBased <ref> 等)
  const xref = buildXRefTable(pdfBytes, pdfText);
  if (opts.debug) {
    console.log(`[figure-pdf] XRef table: ${xref ? `${xref.entries.size} entries` : 'parse FAIL'}`);
  }

  // 1. find all `<n> <m> obj` markers(uncompressed image XObject 由这里 cover;
  //    压缩在 ObjStm 内的 image XObject 罕见,暂不 enumerate XRef 找)
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  const objStarts: Array<{ id: string; offset: number; objNum: number }> = [];
  while ((m = objRe.exec(pdfText)) !== null) {
    objStarts.push({ id: `${m[1]} ${m[2]}`, offset: m.index + m[0].length, objNum: parseInt(m[1], 10) });
  }
  if (opts.debug) console.log(`[figure-pdf] found ${objStarts.length} obj markers`);

  // build objNum → offset index(给 XRef parse fail 时 fallback 用)
  const objByNum = new Map<number, number>();
  for (const o of objStarts) objByNum.set(o.objNum, o.offset);

  // resolve indirect int ref(/Length 12 0 R / 等)
  //   优先用 XRef table(支持 ObjStm 内压缩对象)
  //   fallback sequential scan(uncompressed only)
  function resolveIndirectLength(refStr: string): number | null {
    if (xref) {
      const v = resolveIntRef(xref, refStr, pdfBytes, pdfText);
      if (v !== null) return v;
    }
    // fallback:旧 sequential scan(uncompressed only)
    const m = refStr.match(/^(\d+)\s+\d+\s+R$/);
    if (!m) return null;
    const off = objByNum.get(parseInt(m[1], 10));
    if (off === undefined) return null;
    const slice = pdfText.slice(off, off + 50);
    const numM = slice.match(/^\s*(\d+)\s+endobj/);
    return numM ? parseInt(numM[1], 10) : null;
  }

  // resolve ICCBased ColorSpace ref → channel count
  //   优先 XRef table(可能 ObjStm 内)
  function resolveIccBasedChannels(refOrInline: string): number | null {
    const m = refOrInline.match(/(\d+)\s+\d+\s+R/);
    if (!m) return null;
    const objNum = parseInt(m[1], 10);
    let dict: string | null = null;
    if (xref) {
      dict = resolveObj(xref, objNum, pdfBytes, pdfText);
    }
    if (!dict) {
      // fallback sequential
      const off = objByNum.get(objNum);
      if (off === undefined) return null;
      dict = pdfText.slice(off, off + 500);
    }
    const nM = dict.match(/\/N\s+(\d+)/);
    return nM ? parseInt(nM[1], 10) : null;
  }

  // 2. for each obj,decide if image
  for (let i = 0; i < objStarts.length; i++) {
    if (opts.max && images.length >= opts.max) break;

    const start = objStarts[i].offset;
    const objId = objStarts[i].id;
    // 找 endobj(此 obj 结束),取 dict + stream
    // 优先 inline 看 dict 内 /Length 决定 stream 边界 — 这能精确 cut binary stream
    const dictEnd = pdfText.indexOf('>>', start);
    if (dictEnd === -1) continue;
    const dict = pdfText.slice(start, dictEnd + 2);

    // 必须是 image XObject
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    stats.total_image_xobjects++;

    // parse metadata
    const widthM = dict.match(/\/Width\s+(\d+)/);
    const heightM = dict.match(/\/Height\s+(\d+)/);
    const bpcM = dict.match(/\/BitsPerComponent\s+(\d+)/);
    // /Length 可能 inline `12345` 或 indirect `42 0 R`(后者需 resolve)
    //   inline 后续可能是 `>`(dict end)/ `/`(下一 key)/ space + non-digit
    //   indirect 形如 `12 0 R`,要 resolve obj 拿 number value
    // 用 single regex 取 first digit group + optional ref pattern,后判断
    const lengthAllM = dict.match(/\/Length\s+(\d+)(\s+\d+\s+R)?/);
    const lengthIsIndirect = !!(lengthAllM && lengthAllM[2]);
    const lengthInline = lengthAllM && !lengthIsIndirect ? parseInt(lengthAllM[1], 10) : null;
    const lengthIndirectRef = lengthIsIndirect && lengthAllM ? `${lengthAllM[1]}${lengthAllM[2]}` : null;
    const filterM = dict.match(/\/Filter\s+(\[[^\]]*\]|\/\w+)/);
    const colorSpaceM = dict.match(/\/ColorSpace\s+(\/\w+|\[[^\]]*\])/);

    const width = widthM ? parseInt(widthM[1], 10) : 0;
    const height = heightM ? parseInt(heightM[1], 10) : 0;
    if (!width || !height) {
      bumpSkipped(stats, 'no_dimensions');
      continue;
    }

    // 解析 Filter:可能 `/DCTDecode` 或 `[/FlateDecode]` 或 chain
    const filterStr = filterM ? filterM[1] : '';
    const codec = parseFilter(filterStr);
    bumpCodec(stats, codec);
    if (!codec || (codec !== 'DCTDecode' && codec !== 'FlateDecode')) {
      bumpSkipped(stats, `codec_${codec || 'none'}`);
      continue;
    }

    // ColorSpace:FlateDecode 需要知道 channel 数才能 reconstruct PNG
    //   - /DeviceRGB → 3 / /DeviceGray → 1 / /DeviceCMYK → 4(PNG 不支持,skip)
    //   - [/ICCBased <ref>] → follow ref 拿 /N value(1=Gray / 3=RGB / 4=CMYK)
    //   - [/Indexed ...] → palette image,PNG 支持但 reconstruct 复杂(skip 暂)
    // DCTDecode 不需 reconstruct PNG(stream 是 JPEG),跳过 check
    let channels = 0;
    if (codec === 'FlateDecode') {
      const cs = colorSpaceM ? colorSpaceM[1] : '';
      if (cs === '/DeviceRGB') channels = 3;
      else if (cs === '/DeviceGray') channels = 1;
      else if (cs.includes('/ICCBased')) {
        const n = resolveIccBasedChannels(cs);
        if (n === 1 || n === 3) channels = n;
        else {
          bumpSkipped(stats, n === 4 ? 'cs_iccbased_cmyk' : `cs_iccbased_n${n || '?'}`);
          continue;
        }
      } else {
        bumpSkipped(stats, `cs_${cs.slice(0, 40) || 'unknown'}`);
        continue;
      }
    }

    // DecodeParms /Predictor:PDF FlateDecode 可能加 PNG-style row filter
    // /Predictor 1 = no filter(我们 handle);其他(10-15)需要 unfilter pass(skip)
    const predictorM = dict.match(/\/DecodeParms\s*<<[^>]*\/Predictor\s+(\d+)/);
    if (codec === 'FlateDecode' && predictorM) {
      const pred = parseInt(predictorM[1], 10);
      if (pred !== 1) {
        bumpSkipped(stats, `flate_predictor_${pred}`);
        continue;
      }
    }

    // 找 stream 起始位置
    const streamMarker = pdfText.indexOf('stream', dictEnd);
    if (streamMarker === -1 || streamMarker > dictEnd + 200) {
      // dict 后没紧跟 stream:该 image XObject 可能只是 metadata referrer
      bumpSkipped(stats, 'no_stream');
      continue;
    }
    // skip "stream" + newline(`\n` or `\r\n`)
    let dataStart = streamMarker + 6;  // length of "stream"
    if (pdfBytes[dataStart] === 0x0D) dataStart++;  // \r
    if (pdfBytes[dataStart] === 0x0A) dataStart++;  // \n

    // 决定 stream 长度:优先 inline /Length,然后 indirect ref resolve,最后 fallback endstream
    // **endstream 必须 followed by endobj 才算真正分界**(避免 stream binary 内 false match)
    let streamLen: number;
    if (lengthInline !== null) {
      streamLen = lengthInline;
      if (opts.debug) console.log(`  obj ${objId} length inline=${streamLen}`);
    } else if (lengthIndirectRef) {
      const resolved = resolveIndirectLength(lengthIndirectRef);
      if (resolved === null) {
        bumpSkipped(stats, 'length_indirect_unresolved');
        continue;
      }
      streamLen = resolved;
      if (opts.debug) console.log(`  obj ${objId} length indirect=${streamLen}`);
    } else {
      // fallback:找 endstream + endobj(标准 PDF 一定有,binary 内 false match 概率低)
      const endstreamRe = /\r?\n?endstream\s+endobj/g;
      endstreamRe.lastIndex = dataStart;
      const em = endstreamRe.exec(pdfText);
      if (!em) {
        bumpSkipped(stats, 'no_endstream_endobj');
        continue;
      }
      // length = endstream marker offset - dataStart
      // 但 match 可能含前缀 \r?\n,要找 'endstream' 字面
      const esIdx = pdfText.indexOf('endstream', em.index);
      // 去掉 endstream 前的 \r\n bytes
      let end = esIdx;
      if (pdfText[end - 1] === '\n') end--;
      if (pdfText[end - 1] === '\r') end--;
      streamLen = end - dataStart;
      if (opts.debug) console.log(`  obj ${objId} length fallback=${streamLen}`);
    }

    const streamBytes = pdfBytes.subarray(dataStart, dataStart + streamLen);

    // 3. decode
    try {
      if (codec === 'DCTDecode') {
        // verify JPEG magic
        if (streamBytes.length < 2 || streamBytes[0] !== 0xFF || streamBytes[1] !== 0xD8) {
          bumpSkipped(stats, 'jpeg_bad_magic');
          continue;
        }
        // copy out(streamBytes 是 subarray,引用 pdfBytes 大 buffer;保留小 buffer 给 GC)
        const out = new Uint8Array(streamBytes.length);
        out.set(streamBytes);
        images.push({
          codec: 'DCTDecode',
          bytes: out,
          ext: 'jpg',
          mime: 'image/jpeg',
          width,
          height,
          obj_id: objId,
        });
        stats.extracted++;
      } else {
        // FlateDecode → inflate → reconstruct PNG
        const bits = bpcM ? parseInt(bpcM[1], 10) : 8;
        if (bits !== 8) {
          bumpSkipped(stats, `flate_bpc_${bits}`);
          continue;
        }
        const rawPixels = unzlibSync(streamBytes);
        const expected = width * height * channels;
        if (rawPixels.length !== expected) {
          bumpSkipped(stats, `flate_size_mismatch_${rawPixels.length}_vs_${expected}`);
          continue;
        }
        const png = makePng(rawPixels, width, height, channels, bits);
        images.push({
          codec: 'FlateDecode',
          bytes: png,
          ext: 'png',
          mime: 'image/png',
          width,
          height,
          obj_id: objId,
        });
        stats.extracted++;
      }
    } catch (e) {
      bumpSkipped(stats, `decode_exception_${(e as Error).message?.slice(0, 30) || 'unknown'}`);
    }
  }

  stats.duration_ms = Date.now() - t0;
  return { images, stats };
}

function parseFilter(s: string): string | null {
  if (!s) return null;
  // `/DCTDecode` 直接
  const m = s.match(/\/(\w+)/);
  return m ? m[1] : null;
}

function bumpSkipped(stats: ExtractStats, key: string): void {
  stats.skipped[key] = (stats.skipped[key] || 0) + 1;
}

function bumpCodec(stats: ExtractStats, codec: string | null): void {
  const k = codec || 'unknown';
  stats.by_codec[k] = (stats.by_codec[k] || 0) + 1;
}

// ────────────────────────────────────────────────────────────────────
// PNG assembly(IHDR + IDAT + IEND chunks)
// ────────────────────────────────────────────────────────────────────

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function makePng(
  rawPixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bits: number,
): Uint8Array {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : -1;
  if (colorType === -1) throw new Error(`unsupported channels=${channels}`);

  // IHDR data(13 bytes):width(4)+height(4)+bitDepth(1)+colorType(1)+compression(1)+filter(1)+interlace(1)
  const ihdrData = new Uint8Array(13);
  const dv = new DataView(ihdrData.buffer);
  dv.setUint32(0, width, false);     // BE
  dv.setUint32(4, height, false);
  ihdrData[8] = bits;
  ihdrData[9] = colorType;
  // compression / filter / interlace = 0(default)

  // IDAT = zlib( for each scanline: filter_byte(0) + raw_pixels )
  const bytesPerRow = width * channels;
  const idatRaw = new Uint8Array((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * bytesPerRow;
    const idatOffset = y * (bytesPerRow + 1);
    idatRaw[idatOffset] = 0;  // filter type "None"
    idatRaw.set(rawPixels.subarray(rawOffset, rawOffset + bytesPerRow), idatOffset + 1);
  }
  const idatCompressed = zlibSync(idatRaw);

  // assemble
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const idatChunk = makeChunk('IDAT', idatCompressed);
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const total = PNG_SIG.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const result = new Uint8Array(total);
  let off = 0;
  result.set(PNG_SIG, off); off += PNG_SIG.length;
  result.set(ihdrChunk, off); off += ihdrChunk.length;
  result.set(idatChunk, off); off += idatChunk.length;
  result.set(iendChunk, off);
  return result;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = TE.encode(type);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crc = crc32(crcInput);

  const chunk = new Uint8Array(4 + typeBytes.length + data.length + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 4 + typeBytes.length);
  dv.setUint32(chunk.length - 4, crc, false);
  return chunk;
}

// ────────────────────────────────────────────────────────────────────
// CRC32(PNG spec,standard polynomial 0xEDB88320)
// ────────────────────────────────────────────────────────────────────

let CRC32_TABLE: Uint32Array | null = null;

function crc32(buf: Uint8Array): number {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC32_TABLE[i] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

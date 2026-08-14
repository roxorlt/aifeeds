import {
  UNICODE_15_1_CANONICAL_COMBINING_CLASS,
  UNICODE_15_1_CANONICAL_COMPOSITION,
  UNICODE_15_1_CANONICAL_DECOMPOSITION,
  UNICODE_15_1_COMPATIBILITY_DECOMPOSITION,
  UNICODE_15_1_EXTENDED_PICTOGRAPHIC,
  UNICODE_15_1_GRAPHEME_BREAK,
  UNICODE_15_1_INDIC_CONJUNCT_BREAK,
  type Unicode15Range,
} from './manual-news-unicode15.generated';

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

function assertScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('unicode15_invalid_scalar_string');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('unicode15_invalid_scalar_string');
    }
  }
}

export function isUnicodeScalarString15(value: string): boolean {
  try { assertScalarString(value); return true; } catch { return false; }
}

function decompose(
  codePoint: number,
  decomposition: Readonly<Record<number, readonly number[]>>,
  output: number[],
): void {
  const hangulOffset = codePoint - S_BASE;
  if (hangulOffset >= 0 && hangulOffset < S_COUNT) {
    const leading = L_BASE + Math.floor(hangulOffset / N_COUNT);
    const vowel = V_BASE + Math.floor((hangulOffset % N_COUNT) / T_COUNT);
    const trailing = T_BASE + (hangulOffset % T_COUNT);
    output.push(leading, vowel);
    if (trailing !== T_BASE) output.push(trailing);
    return;
  }
  const mapping = decomposition[codePoint];
  if (mapping) {
    for (const mapped of mapping) decompose(mapped, decomposition, output);
  } else {
    output.push(codePoint);
  }
}

function ccc(codePoint: number): number {
  return UNICODE_15_1_CANONICAL_COMBINING_CLASS[codePoint] || 0;
}

function compose(left: number, right: number): number | undefined {
  const lIndex = left - L_BASE;
  const vIndex = right - V_BASE;
  if (lIndex >= 0 && lIndex < L_COUNT && vIndex >= 0 && vIndex < V_COUNT) {
    return S_BASE + ((lIndex * V_COUNT) + vIndex) * T_COUNT;
  }
  const sIndex = left - S_BASE;
  const tIndex = right - T_BASE;
  if (sIndex >= 0 && sIndex < S_COUNT && sIndex % T_COUNT === 0 && tIndex > 0 && tIndex < T_COUNT) {
    return left + tIndex;
  }
  return UNICODE_15_1_CANONICAL_COMPOSITION[`${left}/${right}`];
}

function codePointsToString(points: readonly number[]): string {
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += 8_192) {
    chunks.push(String.fromCodePoint(...points.slice(index, index + 8_192)));
  }
  return chunks.join('');
}

function normalize(
  value: string,
  decomposition: Readonly<Record<number, readonly number[]>>,
): string {
  assertScalarString(value);
  const decomposed: number[] = [];
  for (const character of value) decompose(character.codePointAt(0)!, decomposition, decomposed);
  for (let index = 1; index < decomposed.length; index += 1) {
    const currentClass = ccc(decomposed[index]);
    if (!currentClass) continue;
    let cursor = index;
    while (cursor > 0 && ccc(decomposed[cursor - 1]) > currentClass) {
      [decomposed[cursor - 1], decomposed[cursor]] = [decomposed[cursor], decomposed[cursor - 1]];
      cursor -= 1;
    }
  }
  if (!decomposed.length) return '';
  const composed = [decomposed[0]];
  let starterIndex = 0;
  let starter = decomposed[0];
  let lastClass = 0;
  for (let index = 1; index < decomposed.length; index += 1) {
    const codePoint = decomposed[index];
    const currentClass = ccc(codePoint);
    const composite = compose(starter, codePoint);
    if (composite !== undefined && (lastClass === 0 || lastClass < currentClass)) {
      composed[starterIndex] = composite;
      starter = composite;
    } else {
      composed.push(codePoint);
      if (currentClass === 0) {
        starterIndex = composed.length - 1;
        starter = codePoint;
      }
      lastClass = currentClass;
    }
  }
  return codePointsToString(composed);
}

export function normalizeNfc15(value: string): string {
  return normalize(value, UNICODE_15_1_CANONICAL_DECOMPOSITION);
}

export function normalizeNfkc15(value: string): string {
  return normalize(value, UNICODE_15_1_COMPATIBILITY_DECOMPOSITION);
}

export function isNfc15(value: string): boolean {
  return isUnicodeScalarString15(value) && normalizeNfc15(value) === value;
}

export function isNfkc15(value: string): boolean {
  return isUnicodeScalarString15(value) && normalizeNfkc15(value) === value;
}

function rangeValue<T extends string>(ranges: readonly Unicode15Range<T>[], codePoint: number, fallback: T): T {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [first, last, value] = ranges[middle];
    if (codePoint < first) high = middle - 1;
    else if (codePoint > last) low = middle + 1;
    else return value;
  }
  return fallback;
}

function inRanges(ranges: readonly (readonly [number, number])[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [first, last] = ranges[middle];
    if (codePoint < first) high = middle - 1;
    else if (codePoint > last) low = middle + 1;
    else return true;
  }
  return false;
}

function graphemeClass(codePoint: number): string {
  return rangeValue(UNICODE_15_1_GRAPHEME_BREAK, codePoint, 'Other');
}

function indicConjunctClass(codePoint: number): string {
  return rangeValue(UNICODE_15_1_INDIC_CONJUNCT_BREAK, codePoint, 'None');
}

function isControl(value: string): boolean {
  return value === 'CR' || value === 'LF' || value === 'Control';
}

function indicConjunctNoBreak(points: readonly number[], index: number): boolean {
  if (indicConjunctClass(points[index]) !== 'Consonant') return false;
  let sawLinker = false;
  let cursor = index - 1;
  while (cursor >= 0) {
    const kind = indicConjunctClass(points[cursor]);
    if (kind === 'Linker') sawLinker = true;
    else if (kind !== 'Extend') return sawLinker && kind === 'Consonant';
    cursor -= 1;
  }
  return false;
}

function emojiZwjNoBreak(points: readonly number[], classes: readonly string[], index: number): boolean {
  if (!inRanges(UNICODE_15_1_EXTENDED_PICTOGRAPHIC, points[index])) return false;
  let cursor = index - 1;
  if (classes[cursor] !== 'ZWJ') return false;
  cursor -= 1;
  while (cursor >= 0 && classes[cursor] === 'Extend') cursor -= 1;
  return cursor >= 0 && inRanges(UNICODE_15_1_EXTENDED_PICTOGRAPHIC, points[cursor]);
}

interface GraphemeMetrics { regionalIndicatorBoundaryChecks: number; }

function regionalIndicatorNoBreak(
  classes: readonly string[],
  index: number,
  previousRiRunLength: number,
  metrics: GraphemeMetrics | undefined,
): boolean {
  if (classes[index - 1] !== 'Regional_Indicator' || classes[index] !== 'Regional_Indicator') return false;
  if (metrics) metrics.regionalIndicatorBoundaryChecks += 1;
  return previousRiRunLength % 2 === 1;
}

function shouldBreak(
  points: readonly number[], classes: readonly string[], index: number,
  previousRiRunLength: number, metrics?: GraphemeMetrics,
): boolean {
  const previous = classes[index - 1];
  const current = classes[index];
  if (previous === 'CR' && current === 'LF') return false;
  if (isControl(previous) || isControl(current)) return true;
  if (previous === 'L' && ['L', 'V', 'LV', 'LVT'].includes(current)) return false;
  if (['LV', 'V'].includes(previous) && ['V', 'T'].includes(current)) return false;
  if (['LVT', 'T'].includes(previous) && current === 'T') return false;
  if (['Extend', 'ZWJ', 'SpacingMark'].includes(current) || previous === 'Prepend') return false;
  if (indicConjunctNoBreak(points, index) || emojiZwjNoBreak(points, classes, index)
    || regionalIndicatorNoBreak(classes, index, previousRiRunLength, metrics)) return false;
  return true;
}

function segmentExtendedGraphemes(value: string, metrics?: GraphemeMetrics): string[] {
  assertScalarString(value);
  const points = Array.from(value, (character) => character.codePointAt(0)!);
  if (!points.length) return [];
  const classes = points.map(graphemeClass);
  const boundaries = [0];
  let regionalIndicatorRunLength = classes[0] === 'Regional_Indicator' ? 1 : 0;
  for (let index = 1; index < points.length; index += 1) {
    const breaks = shouldBreak(points, classes, index, regionalIndicatorRunLength, metrics);
    if (breaks) boundaries.push(index);
    regionalIndicatorRunLength = classes[index] === 'Regional_Indicator' && !breaks && classes[index - 1] === 'Regional_Indicator'
      ? regionalIndicatorRunLength + 1
      : classes[index] === 'Regional_Indicator' ? 1 : 0;
  }
  boundaries.push(points.length);
  return boundaries.slice(0, -1).map((start, index) => codePointsToString(points.slice(start, boundaries[index + 1])));
}

export function segmentExtendedGraphemes15(value: string): string[] {
  return segmentExtendedGraphemes(value);
}

export function segmentExtendedGraphemes15WithMetrics(value: string): {
  segments: string[];
  regional_indicator_boundary_checks: number;
} {
  const metrics = { regionalIndicatorBoundaryChecks: 0 };
  return {
    segments: segmentExtendedGraphemes(value, metrics),
    regional_indicator_boundary_checks: metrics.regionalIndicatorBoundaryChecks,
  };
}

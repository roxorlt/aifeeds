import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isNfc15,
  isNfkc15,
  normalizeNfc15,
  normalizeNfkc15,
  segmentExtendedGraphemes15,
} from './manual-news-unicode15';

const UCD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../vendor/unicode/15.1.0/ucd');

function codePoints(field: string): string {
  return field.trim().split(' ').filter(Boolean).map((value) => String.fromCodePoint(Number.parseInt(value, 16))).join('');
}

function normalizationCases(): Array<{ nfcSources: string[]; nfkcSources: string[]; nfc: string; nfkc: string }> {
  return readFileSync(resolve(UCD_ROOT, 'NormalizationTest.txt'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*/u, '').trim())
    .filter((line) => line && !line.startsWith('@'))
    .map((line) => line.split(';').map((field) => field.trim()))
    .flatMap(([c1, c2, c3, c4, c5]) => {
      const nfc = codePoints(c2!);
      const nfkc = codePoints(c4!);
      return [{
        nfcSources: [c1, c2, c3].map((field) => codePoints(field!)),
        nfkcSources: [c1, c2, c3, c4, c5].map((field) => codePoints(field!)),
        nfc,
        nfkc,
      }];
    });
}

function graphemeCases(): Array<{ source: string; expected: string[] }> {
  return readFileSync(resolve(UCD_ROOT, 'auxiliary/GraphemeBreakTest.txt'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*/u, '').trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = line.split(/\s+/u);
      const expected: string[] = [];
      let current = '';
      for (const token of tokens) {
        if (token === '÷') {
          if (current) expected.push(current);
          current = '';
        } else if (token !== '×') {
          current += String.fromCodePoint(Number.parseInt(token, 16));
        }
      }
      if (current) expected.push(current);
      return { source: expected.join(''), expected };
    });
}

describe('pinned Unicode 15.1 algorithms', () => {
  it('matches every Unicode 15.1 NormalizationTest NFC C1..C5 relation without ambient normalization', () => {
    for (const { nfcSources, nfkcSources, nfc, nfkc } of normalizationCases()) {
      for (const source of nfcSources) {
        expect(normalizeNfc15(source)).toBe(nfc);
        expect(isNfc15(source)).toBe(source === nfc);
      }
      for (const source of nfkcSources.slice(3)) {
        expect(normalizeNfc15(source)).toBe(nfkc);
        expect(isNfc15(source)).toBe(source === nfkc);
      }
    }
  });

  it('matches every Unicode 15.1 NormalizationTest NFKC relation without ambient normalization', () => {
    for (const { nfkcSources, nfkc } of normalizationCases()) {
      for (const source of nfkcSources) {
        expect(normalizeNfkc15(source)).toBe(nfkc);
        expect(isNfkc15(source)).toBe(source === nfkc);
      }
    }
  });

  it('performs pinned compatibility normalization and remains bounded on long ASCII input', () => {
    expect(normalizeNfkc15('①')).toBe('1');
    expect(normalizeNfkc15('ﬃ')).toBe('ffi');
    expect(normalizeNfkc15('ＡＢＣ')).toBe('ABC');
    expect(normalizeNfkc15('\u1100\u1161')).toBe('가');
    expect(normalizeNfkc15('e\u0301')).toBe('é');
    const longAscii = 'a'.repeat(200_000);
    expect(normalizeNfc15(longAscii)).toBe(longAscii);
    expect(normalizeNfkc15(longAscii)).toBe(longAscii);
  });

  it('matches every Unicode 15.1 extended grapheme break vector without Intl.Segmenter', () => {
    for (const { source, expected } of graphemeCases()) {
      expect(segmentExtendedGraphemes15(source)).toEqual(expected);
    }
  });
});

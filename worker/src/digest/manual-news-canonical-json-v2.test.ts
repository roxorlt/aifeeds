import { describe, expect, it } from 'vitest';

import { canonicalJsonV2, canonicalJsonV2Utf8 } from './manual-news-canonical-json-v2';

describe('manual-news canonical JSON v2', () => {
  it('uses Unicode scalar key order and a fixed JSON escape profile', () => {
    const value = {
      '\u{10000}': 'astral key',
      '\uE000': 'bmp private-use key',
      a: 'quote" slash\\ backspace\b tab\t line\n form\f return\r nul\0',
    };

    expect(canonicalJsonV2(value)).toBe(
      '{"a":"quote\\" slash\\\\ backspace\\b tab\\t line\\n form\\f return\\r nul\\u0000","\uE000":"bmp private-use key","𐀀":"astral key"}',
    );
    expect(Array.from(canonicalJsonV2Utf8({ value: '中文🙂' }))).toEqual(
      Array.from(new TextEncoder().encode('{"value":"中文🙂"}')),
    );
  });

  it('accepts only the v2 JSON domain and rejects invalid numeric, object, scalar, and NFC inputs', () => {
    expect(canonicalJsonV2({ zero: 0, minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, values: [null, true, false] }))
      .toBe('{"maximum":9007199254740991,"minimum":-9007199254740991,"values":[null,true,false],"zero":0}');

    for (const [name, value] of [['float', 0.5], ['NaN', Number.NaN], ['positive infinity', Number.POSITIVE_INFINITY], ['negative infinity', Number.NEGATIVE_INFINITY], ['negative zero', -0], ['undefined', undefined], ['Date', new Date()], ['RegExp', /x/u], ['inherited prototype', Object.create({ inherited: true })], ['undefined property', { bad: undefined }], ['unpaired surrogate', { bad: String.fromCharCode(0xd800) }], ['non-NFC string', { bad: 'e\u0301' }]] as const) {
      expect(() => canonicalJsonV2(value), name).toThrow('manual_news_canonical_json_v2_invalid');
    }
  });

  it('fails closed on cycles rather than producing a partial serialization', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalJsonV2(value)).toThrow('manual_news_canonical_json_v2_invalid');
  });

  it('accepts only dense data-only arrays with exactly their 0..length-1 indices', () => {
    const sparseOne = Array(1);
    const sparseLeading = Array(2);
    sparseLeading[1] = 1;
    const extraEnumerable = [1];
    Object.assign(extraEnumerable, { extra: true, 4294967295: 'not-an-index' });
    const extraHidden = [1];
    Object.defineProperty(extraHidden, 'hidden', { value: true });
    const extraSymbol = [1];
    Object.defineProperty(extraSymbol, Symbol('extra'), { value: true });
    const accessorIndex: unknown[] = [];
    Object.defineProperty(accessorIndex, '0', { enumerable: true, get: () => 1 });
    accessorIndex.length = 1;
    const customPrototype = [1];
    Object.setPrototypeOf(customPrototype, { inherited: true });
    const inheritedAccessor = [1];
    Object.setPrototypeOf(inheritedAccessor, { get inherited() { return true; } });

    expect(canonicalJsonV2([])).toBe('[]');
    expect(canonicalJsonV2([null, 1])).toBe('[null,1]');
    for (const value of [sparseOne, sparseLeading, extraEnumerable, extraHidden, extraSymbol, accessorIndex, customPrototype, inheritedAccessor]) {
      expect(() => canonicalJsonV2(value)).toThrow('manual_news_canonical_json_v2_invalid');
    }
  });
});

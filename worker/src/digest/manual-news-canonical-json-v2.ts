import { isNfc15, isUnicodeScalarString15 } from './manual-news-unicode15';

const INVALID = 'manual_news_canonical_json_v2_invalid';

function invalid(): never {
  throw new Error(INVALID);
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function quote(value: string): string {
  if (!isUnicodeScalarString15(value) || !isNfc15(value)) invalid();
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"') result += '\\"';
    else if (character === '\\') result += '\\\\';
    else if (character === '\b') result += '\\b';
    else if (character === '\t') result += '\\t';
    else if (character === '\n') result += '\\n';
    else if (character === '\f') result += '\\f';
    else if (character === '\r') result += '\\r';
    else if (codePoint < 0x20) result += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    else result += character;
  }
  return `${result}"`;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
    return String(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) invalid();
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownNames = Object.getOwnPropertyNames(value);
      if (ownNames.length !== value.length + 1 || !Object.prototype.hasOwnProperty.call(descriptors, 'length')) invalid();
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        items.push(canonical(descriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!value || typeof value !== 'object' || !isPlainObject(value) || ancestors.has(value)) invalid();
  if (Object.getOwnPropertySymbols(value).length) invalid();
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort(compareUnicodeScalars);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    }
    return `{${keys.map((key) => `${quote(key)}:${canonical(descriptors[key].value, ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonV2(value: unknown): string {
  return canonical(value, new Set());
}

export function canonicalJsonV2Utf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonV2(value));
}

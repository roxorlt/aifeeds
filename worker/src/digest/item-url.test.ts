// Task 1（item SSR 静态页）：itemPagePath 五源映射 + 反向源映射 + fetchItemRow 取数抽取。
import { describe, test, expect } from 'vitest';

import { itemPagePath, ITEM_URL_SOURCES, sourceTypeToUrlSource } from './render';
import { fetchItemRow } from './item-fetch';
import type { Env } from '../index';

describe('itemPagePath', () => {
  test('x_list → /i/x/<statusId>', () => {
    expect(itemPagePath('x_list:1234567890')).toBe('/i/x/1234567890');
  });

  test('github → /i/gh/<owner>/<repo>（双段保留）', () => {
    expect(itemPagePath('github:openai/whisper')).toBe('/i/gh/openai/whisper');
  });

  test('product_hunt → /i/ph/<slug>（丢弃末尾 :date）', () => {
    expect(itemPagePath('product_hunt:cool-tool:2026-07-08')).toBe('/i/ph/cool-tool');
  });

  test('product_hunt 无 date 也返回 /i/ph/<slug>', () => {
    expect(itemPagePath('product_hunt:cool-tool')).toBe('/i/ph/cool-tool');
  });

  test('hf_paper → /i/paper/<arxivId>（URL 段用 paper，不是 hf-paper）', () => {
    expect(itemPagePath('hf_paper:2501.12345')).toBe('/i/paper/2501.12345');
  });

  test('blog → /i/news/<url-safe(整 composite id)>', () => {
    expect(itemPagePath('blog:aiera:7a92bf376b043118')).toBe(
      '/i/news/blog%3Aaiera%3A7a92bf376b043118',
    );
  });

  test('podcast → /i/news/<url-safe(整 composite id)>', () => {
    expect(itemPagePath('podcast:xiaoyuzhou:abc-123')).toBe(
      '/i/news/podcast%3Axiaoyuzhou%3Aabc-123',
    );
  });

  test('clawhub → null（不出静态页）', () => {
    expect(itemPagePath('clawhub:some-package')).toBeNull();
  });

  test('huodongxing → null（不出静态页）', () => {
    expect(itemPagePath('huodongxing:event-4567')).toBeNull();
  });

  test('未知源 / 乱码 → null', () => {
    expect(itemPagePath('weibo:456')).toBeNull();
    expect(itemPagePath('garbage-no-colon')).toBeNull();
    expect(itemPagePath('')).toBeNull();
  });

  test('github 单段（缺 repo）→ null', () => {
    expect(itemPagePath('github:onlyowner')).toBeNull();
  });

  test('x_list 空 id → null', () => {
    expect(itemPagePath('x_list:')).toBeNull();
  });
});

describe('ITEM_URL_SOURCES', () => {
  test('恰好是 5 个出页源段', () => {
    expect([...ITEM_URL_SOURCES]).toEqual(['x', 'gh', 'ph', 'paper', 'news']);
  });
});

describe('sourceTypeToUrlSource（反向于 selection.SOURCE_TYPE）', () => {
  test('出页 source_type 映射到 URL 段', () => {
    expect(sourceTypeToUrlSource('x_list')).toBe('x');
    expect(sourceTypeToUrlSource('github')).toBe('gh');
    expect(sourceTypeToUrlSource('product_hunt')).toBe('ph');
    expect(sourceTypeToUrlSource('hf_paper')).toBe('paper');
    expect(sourceTypeToUrlSource('blog')).toBe('news');
    expect(sourceTypeToUrlSource('podcast')).toBe('news');
  });

  test('不出页 source_type → null', () => {
    expect(sourceTypeToUrlSource('clawhub')).toBeNull();
    expect(sourceTypeToUrlSource('huodongxing')).toBeNull();
    expect(sourceTypeToUrlSource('weibo')).toBeNull();
  });
});

describe('fetchItemRow', () => {
  const makeEnv = (row: unknown): Env =>
    ({
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => row,
          }),
        }),
      },
    }) as unknown as Env;

  test('命中：返回该行', async () => {
    const row = {
      id: 'x_list:1',
      title: 't',
      content: null,
      content_translated: null,
      author: null,
      handle: null,
      url: null,
      media: null,
      extra: null,
    };
    const got = await fetchItemRow(makeEnv(row), 'x_list:1');
    expect(got).toEqual(row);
  });

  test('未命中：返回 null', async () => {
    const got = await fetchItemRow(makeEnv(null), 'x_list:missing');
    expect(got).toBeNull();
  });
});

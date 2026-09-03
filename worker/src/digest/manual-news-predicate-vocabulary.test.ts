import { describe, expect, test } from 'vitest';

import {
  FACT_ACTION_IDS,
  FACT_ACTION_VOCABULARY,
  factActionOccurrences,
} from './manual-news-leads';

describe('谓语动作词表与正则同步', () => {
  test('词表覆盖 FACT_ACTION_PATTERNS 的每一个动作，且不含表外动作', () => {
    const vocabularyActions = FACT_ACTION_VOCABULARY.map((entry) => entry.action);
    expect([...vocabularyActions].sort()).toEqual([...FACT_ACTION_IDS].sort());
    expect(new Set(vocabularyActions).size).toBe(vocabularyActions.length);
  });

  test('词表每条写法都恰好命中它自己的动作', () => {
    for (const entry of FACT_ACTION_VOCABULARY) {
      expect(entry.zh.length + entry.en.length).toBeGreaterThanOrEqual(2);
      expect(entry.zh.length + entry.en.length).toBeLessThanOrEqual(8);
      for (const surface of [...entry.zh, ...entry.en]) {
        const occurrences = factActionOccurrences(surface);
        expect(
          occurrences.map((item) => item.action),
          `${entry.action} / ${surface}`,
        ).toEqual([entry.action]);
      }
    }
  });

  test('中文写法只含中文，英文写法只含 ASCII', () => {
    for (const entry of FACT_ACTION_VOCABULARY) {
      for (const surface of entry.zh) expect(surface).toMatch(/\p{Script=Han}/u);
      for (const surface of entry.en) expect(surface).toMatch(/^[\x20-\x7e]+$/u);
    }
  });
});

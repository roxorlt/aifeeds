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
      expect(entry.zh.length).toBeLessThanOrEqual(5);
      expect(entry.en.length).toBeLessThanOrEqual(5);
      for (const surface of [...entry.zh, ...entry.en]) {
        const occurrences = factActionOccurrences(surface);
        expect(
          occurrences.map((item) => item.action),
          `${entry.action} / ${surface}`,
        ).toEqual([entry.action]);
      }
    }
  });

  test('通告动词让位：通告词后面紧跟别的动作时，只保留后面那个动作', () => {
    const actions = (value: string) => factActionOccurrences(value).map((item) => item.action);
    expect(actions('宣布收购')).toEqual(['acquire']);
    expect(actions('宣布禁止')).toEqual(['ban']);
    expect(actions('announced it will acquire')).toEqual(['acquire']);
    expect(actions('announced the acquisition')).toEqual(['release']);
    expect(actions('announced Gemini 3.8 Flash')).toEqual(['release']);
    expect(actions('宣布 Gemini 3.8 Flash')).toEqual(['release']);
    // 通告词与后一个动作离得远（> 24 字符）时不让位，仍是两个动作。
    expect(actions('announced a broad set of platform changes and then acquired Bun').length)
      .toBeGreaterThan(1);
    // 「宣布推出」「正式推出」整体只算一个 release，不因为拆词变成两个。
    expect(actions('宣布推出')).toEqual(['release']);
    expect(actions('正式推出')).toEqual(['release']);
  });

  test('嵌套匹配只保留最外层，不把同一段文字算成两个动作', () => {
    const actions = (value: string) => factActionOccurrences(value).map((item) => item.action);
    expect(actions('达成合作')).toEqual(['partner']);
    expect(actions('开放源码')).toEqual(['open_source']);
    expect(actions('获得战略投资')).toEqual(['finance']);
  });

  test('新增动作认得常见 AI 新闻动词', () => {
    const actions = (value: string) => factActionOccurrences(value).map((item) => item.action);
    expect(actions('更新')).toEqual(['update']);
    expect(actions('升级')).toEqual(['update']);
    expect(actions('updated')).toEqual(['update']);
    expect(actions('部署')).toEqual(['deploy']);
    expect(actions('deployed')).toEqual(['deploy']);
    expect(actions('任命')).toEqual(['appoint']);
    expect(actions('appoints')).toEqual(['appoint']);
    expect(actions('离职')).toEqual(['depart']);
    expect(actions('resigned')).toEqual(['depart']);
    expect(actions('突破')).toEqual(['reach']);
    expect(actions('surpassed')).toEqual(['reach']);
    expect(actions('警告')).toEqual(['warn']);
    expect(actions('warns')).toEqual(['warn']);
    expect(actions('测试')).toEqual(['test']);
    expect(actions('piloted')).toEqual(['test']);
  });

  test('新增动作不会被词内子串误命中', () => {
    const actions = (value: string) => factActionOccurrences(value).map((item) => item.action);
    expect(actions('deployment')).toEqual([]);
    expect(actions('disappointed')).toEqual([]);
    expect(actions('department')).toEqual([]);
    expect(actions('outreach')).toEqual([]);
    expect(actions('latest')).toEqual([]);
    expect(actions('模型部署活动')).toEqual([]);
  });

  test('中文写法只含中文，英文写法只含 ASCII', () => {
    for (const entry of FACT_ACTION_VOCABULARY) {
      for (const surface of entry.zh) expect(surface).toMatch(/\p{Script=Han}/u);
      for (const surface of entry.en) expect(surface).toMatch(/^[\x20-\x7e]+$/u);
    }
  });
});

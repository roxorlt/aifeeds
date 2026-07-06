import { test, expect } from 'vitest';

import { DAILY_PAGE_PER_SOURCE_LIMIT } from './config';

// 每日静态日报页：每个源在页面上最多展示的条数（Task 2/3 消费）。
test('DAILY_PAGE_PER_SOURCE_LIMIT 固定为 20', () => {
  expect(DAILY_PAGE_PER_SOURCE_LIMIT).toBe(20);
});

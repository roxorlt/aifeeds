import { describe, expect, test } from 'vitest';

import { routeSourceCronActions } from './cron-routing';

describe('source cron action routing', () => {
  test('keeps blog, HDX, and HF drains together at an even-hour :20 slot', () => {
    expect(routeSourceCronActions({ utcHour: 2, utcMinute: 20 })).toEqual(expect.arrayContaining([
      'blog-fetch',
      'hdx-auto-drain',
      'hf-pending-drain',
    ]));
  });

  test('keeps podcast visible alongside :50 work instead of shadowing it', () => {
    expect(routeSourceCronActions({ utcHour: 1, utcMinute: 50 })).toEqual(expect.arrayContaining([
      'weibo-hot-fetch',
      'podcast-fetch',
      'hdx-auto-drain',
      'hf-pending-drain',
    ]));
  });

  test('moves HF fetch after the 08:00 BJT digest race window', () => {
    expect(routeSourceCronActions({ utcHour: 0, utcMinute: 0 })).not.toContain('hf-daily-fetch');
    expect(routeSourceCronActions({ utcHour: 0, utcMinute: 5 })).toContain('hf-daily-fetch');
  });

  test('gives GH and HF drains stable non-shadowing cadences', () => {
    for (const minute of [10, 40]) {
      expect(routeSourceCronActions({ utcHour: 12, utcMinute: minute })).toContain('github-pending-drain');
    }
    for (const minute of [20, 50]) {
      expect(routeSourceCronActions({ utcHour: 12, utcMinute: minute })).toContain('hf-pending-drain');
    }
  });

  test('emits a readiness snapshot at 07:55 BJT before the 08:00 digest', () => {
    expect(routeSourceCronActions({ utcHour: 23, utcMinute: 55 })).toContain('source-readiness-snapshot');
  });

  test('runs delayed daily video object GC once per day at 03:30 BJT', () => {
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 30 })).toContain('daily-video-gc');
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 35 })).not.toContain('daily-video-gc');
  });

  test('runs blog and podcast workflow recovery together without shadowing other :30 work', () => {
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 30 })).toEqual(expect.arrayContaining([
      'daily-video-gc',
      'blog-workflow-recovery',
      'podcast-workflow-recovery',
    ]));
  });
});

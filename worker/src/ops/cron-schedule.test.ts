import { describe, expect, test } from 'vitest';
import { getTaskDef } from './cron-schedule';

describe('warning cron task registry', () => {
  test('keeps drain, retention and legacy digest as three distinct tasks', () => {
    expect(getTaskDef('warning-outbox-drain')).toMatchObject({
      source: 'common', category: 'system', bjt_times: ['*/5'], frequency: 'every-5-min',
    });
    expect(getTaskDef('warning-outbox-retention')).toMatchObject({
      source: 'common', category: 'cleanup', bjt_times: ['11:35'], frequency: 'daily',
    });
    expect(getTaskDef('warning-digest')).toMatchObject({
      source: 'common', category: 'system', bjt_times: ['07:00'], frequency: 'daily',
    });
  });

  test('registers both hourly canonical backfill lanes independently', () => {
    expect(getTaskDef('warning-subject-backfill-blog')).toMatchObject({
      source: 'blog', category: 'backfill', bjt_times: ['*:15'], frequency: 'hourly-1x',
    });
    expect(getTaskDef('warning-subject-backfill-podcast')).toMatchObject({
      source: 'podcast', category: 'backfill', bjt_times: ['*:15'], frequency: 'hourly-1x',
    });
  });

  test('registers capacity produce, drain, and retention independently from migration 039 tasks', () => {
    expect(getTaskDef('publication-capacity-warning-produce')).toMatchObject({
      source: 'common', category: 'system', bjt_times: ['*/5'], frequency: 'every-5-min',
    });
    expect(getTaskDef('publication-capacity-warning-drain')).toMatchObject({
      source: 'common', category: 'system', bjt_times: ['*/5'], frequency: 'every-5-min',
    });
    expect(getTaskDef('publication-capacity-warning-retention')).toMatchObject({
      source: 'common', category: 'cleanup', bjt_times: ['11:35'], frequency: 'daily',
    });
    expect(getTaskDef('warning-outbox-drain')?.name).not.toBe(getTaskDef('publication-capacity-warning-drain')?.name);
  });
});

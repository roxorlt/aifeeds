import { describe, expect, test } from 'vitest';
import { describeCronCadence } from './admin-tasks';
import { getTaskDef } from './ops/cron-schedule';

describe('admin task cadence display', () => {
  test('renders every-five-minute as a cadence band rather than a midnight point', () => {
    expect(describeCronCadence({ frequency: 'every-5-min', bjt_times: ['*/5'] })).toEqual({
      display_kind: 'cadence-band', frequency_label: '每 5 分钟（288 次/日）',
    });
  });

  test('preserves daily and hourly point behavior and fails unknown values closed', () => {
    expect(describeCronCadence({ frequency: 'daily', bjt_times: ['11:35'] }).display_kind).toBe('point');
    expect(describeCronCadence({ frequency: 'hourly-1x', bjt_times: ['*:30'] }).display_kind).toBe('repeated-points');
    expect(describeCronCadence({ frequency: 'mystery', bjt_times: ['*/7'] })).toEqual({
      display_kind: 'unknown', frequency_label: '未知频率',
    });
  });

  test('renders both capacity every-five-minute actions as distinct cadence bands', () => {
    const tasks = [
      getTaskDef('publication-capacity-warning-produce'),
      getTaskDef('publication-capacity-warning-drain'),
    ];
    expect(tasks.every(Boolean)).toBe(true);
    expect(tasks.map((task) => task?.name)).toEqual([
      'publication-capacity-warning-produce', 'publication-capacity-warning-drain',
    ]);
    for (const task of tasks) {
      expect(describeCronCadence(task!)).toEqual({
        display_kind: 'cadence-band', frequency_label: '每 5 分钟（288 次/日）',
      });
    }
  });
});

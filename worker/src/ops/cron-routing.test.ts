import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { routeSourceCronActions } from './cron-routing';

const indexSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');

describe('source cron action routing', () => {
  test('routes reliable warning actions independently on the existing five-minute cadence', () => {
    expect(routeSourceCronActions({ utcHour: 12, utcMinute: 10 })).toEqual(expect.arrayContaining([
      'warning-outbox-drain',
      'publication-capacity-warning-produce',
      'publication-capacity-warning-drain',
    ]));
    expect(routeSourceCronActions({ utcHour: 3, utcMinute: 35 })).toEqual(expect.arrayContaining([
      'warning-outbox-drain', 'warning-outbox-retention',
      'publication-capacity-warning-produce', 'publication-capacity-warning-drain',
      'publication-capacity-warning-retention',
    ]));
    expect(routeSourceCronActions({ utcHour: 23, utcMinute: 0 })).toEqual(expect.arrayContaining([
      'warning-outbox-drain', 'warning-digest',
    ]));
    expect(routeSourceCronActions({ utcHour: 23, utcMinute: 5 })).not.toContain('warning-digest');
  });

  test('registers every routed action in its own waitUntil and records warning task names independently', () => {
    const scheduled = indexSource.slice(indexSource.indexOf('async scheduled('));
    expect(scheduled).toContain('for (const action of sourceActions)');
    expect(scheduled).toContain('ctx.waitUntil(');
    expect(scheduled).toContain('runScheduledSourceAction(env, action)');
    expect(scheduled).toContain('.catch((error) => console.error(`[cron] source action ${action} failed:`');
    for (const name of [
      'warning-outbox-drain', 'warning-outbox-retention', 'warning-digest',
      'publication-capacity-warning-produce', 'publication-capacity-warning-drain',
      'publication-capacity-warning-retention',
    ]) {
      expect(indexSource).toContain(`{ name: '${name}', source: 'common'`);
    }
    for (const name of [
      'publication-capacity-warning-produce', 'publication-capacity-warning-drain',
      'publication-capacity-warning-retention',
    ]) {
      const start = indexSource.indexOf(`case '${name}'`);
      const end = indexSource.indexOf('\n    case ', start + 1);
      const block = indexSource.slice(start, end < 0 ? undefined : end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(block).toContain('recordCronRunRequired(');
      expect(block).toContain('serializePublicationCapacityCronObservation');
    }
  });
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

  test('never schedules publication object deletion', () => {
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 30 })).not.toContain('daily-video-gc');
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 35 })).not.toContain('daily-video-gc');
  });

  test('runs blog and podcast workflow recovery together without shadowing other :30 work', () => {
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 30 })).toEqual(expect.arrayContaining([
      'blog-workflow-recovery',
      'podcast-workflow-recovery',
    ]));
  });

  test('runs canonical blog and podcast backfills as independent hourly waitUntil actions', () => {
    expect(routeSourceCronActions({ utcHour: 19, utcMinute: 15 })).toEqual(expect.arrayContaining([
      'warning-subject-backfill-blog',
      'warning-subject-backfill-podcast',
      'warning-outbox-drain',
    ]));
    const start = indexSource.indexOf("case 'warning-subject-backfill-blog'");
    const end = indexSource.indexOf("\n    case 'warning-digest'", start);
    const block = indexSource.slice(start, end < 0 ? undefined : end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toContain("case 'warning-subject-backfill-podcast'");
    expect(block).toContain('recordCronRunRequired(');
    expect(block).toContain('runWarningCanonicalBackfill');
  });

  test('workflow recovery uses the required durable recorder for outbox partial and conflict results', () => {
    for (const action of ['blog-workflow-recovery', 'podcast-workflow-recovery']) {
      const start = indexSource.indexOf(`case '${action}'`);
      const end = indexSource.indexOf('\n    case ', start + 1);
      const block = indexSource.slice(start, end < 0 ? undefined : end);
      expect(block).toContain('recordCronRunRequired(');
      expect(block).toContain('workflowRecoveryObservationError');
    }
    expect(indexSource).toContain("return 'warning_outbox_invalid_gate_combination'");
    expect(indexSource).toContain('warning_outbox_partial:enqueue_failed=');
  });
});

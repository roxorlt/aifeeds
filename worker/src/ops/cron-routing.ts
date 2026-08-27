export type SourceCronAction =
  | 'blog-fetch'
  | 'blog-workflow-recovery'
  | 'github-pending-drain'
  | 'hdx-auto-drain'
  | 'hf-daily-fetch'
  | 'hf-pending-drain'
  | 'podcast-fetch'
  | 'podcast-workflow-recovery'
  | 'publication-capacity-warning-drain'
  | 'publication-capacity-warning-produce'
  | 'publication-capacity-warning-retention'
  | 'source-readiness-snapshot'
  | 'warning-digest'
  | 'warning-outbox-drain'
  | 'warning-outbox-retention'
  | 'warning-subject-backfill-blog'
  | 'warning-subject-backfill-podcast'
  | 'weibo-hot-fetch';

export type UtcCronSlot = {
  utcHour: number;
  utcMinute: number;
};

const PODCAST_UTC_HOURS = new Set([1, 7, 13, 19]);

/**
 * Pure routing decision for source tasks that currently overlap in scheduled().
 * Callers execute every returned action; array order is deterministic but does
 * not imply that a prior action may shadow a later one.
 */
export function routeSourceCronActions(slot: UtcCronSlot): SourceCronAction[] {
  const { utcHour: hour, utcMinute: minute } = slot;
  const actions: SourceCronAction[] = [];

  // Reliable D1 outbox is an independent action on every existing */5 tick.
  actions.push(
    'warning-outbox-drain',
    'publication-capacity-warning-produce',
    'publication-capacity-warning-drain',
  );
  if (hour === 3 && minute === 35) actions.push('warning-outbox-retention');
  if (hour === 3 && minute === 35) actions.push('publication-capacity-warning-retention');
  // Legacy KV digest keeps its sole UTC 23:00 lane, but is no longer hidden
  // inside the early-return legacy dispatcher.
  if (hour === 23 && minute === 0) actions.push('warning-digest');
  if (minute === 15) actions.push('warning-subject-backfill-blog', 'warning-subject-backfill-podcast');

  // BJT 07:55, five minutes before the 08:00 digest.
  if (hour === 23 && minute === 55) actions.push('source-readiness-snapshot');

  // BJT 08:05, after the digest selection boundary.
  if (hour === 0 && minute === 5) actions.push('hf-daily-fetch');

  if (minute === 10 || minute === 40) actions.push('github-pending-drain');

  if (minute === 30) actions.push('blog-workflow-recovery', 'podcast-workflow-recovery');

  if (minute === 20 || minute === 50) {
    actions.push('hdx-auto-drain', 'hf-pending-drain');
  }

  if (minute === 50 || (minute === 20 && hour % 2 !== 0)) {
    actions.push('weibo-hot-fetch');
  }
  if (minute === 20 && hour % 2 === 0) actions.push('blog-fetch');
  if (minute === 50 && PODCAST_UTC_HOURS.has(hour)) actions.push('podcast-fetch');

  return actions;
}

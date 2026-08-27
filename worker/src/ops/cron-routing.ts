export type SourceCronAction =
  | 'blog-fetch'
  | 'blog-workflow-recovery'
  | 'daily-video-gc'
  | 'github-pending-drain'
  | 'hdx-auto-drain'
  | 'hf-daily-fetch'
  | 'hf-pending-drain'
  | 'podcast-fetch'
  | 'podcast-workflow-recovery'
  | 'source-readiness-snapshot'
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

  // BJT 07:55, five minutes before the 08:00 digest.
  if (hour === 23 && minute === 55) actions.push('source-readiness-snapshot');

  // BJT 08:05, after the digest selection boundary.
  if (hour === 0 && minute === 5) actions.push('hf-daily-fetch');

  // BJT 03:30:清理已延迟至少 48 小时且不再被 daily_videos 引用的媒体对象。
  if (hour === 19 && minute === 30) actions.push('daily-video-gc');

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

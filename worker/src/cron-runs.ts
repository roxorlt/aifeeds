// cron 任务执行记录 helper。
// 在 scheduled() 里包一层 recordCronRun(env, task, () => run...) 即可:
//   - 自动记录 started_at / finished_at / duration_ms / status / error
//   - 从 result 智能抽 subrequests / items_count
//   - 截断 result_json 防 D1 row 过大
// 写表失败只 console.error,不影响原任务执行。
import type { Env } from './index';

export type CronCategory =
  | 'fetch'
  | 'enrich'
  | 'backfill'
  | 'refresh'
  | 'cleanup'
  | 'system';

export interface CronTaskMeta {
  name: string;
  source?: string;
  category: CronCategory;
}

export async function recordCronRun<T>(
  env: Env,
  task: CronTaskMeta,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let result: T | null = null;
  let status: 'ok' | 'error' = 'ok';
  let error: string | null = null;
  try {
    result = await fn();
    return result;
  } catch (e) {
    status = 'error';
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw e;
  } finally {
    const finishedAt = Date.now();
    try {
      await env.DB.prepare(
        `INSERT INTO cron_runs
           (task_name, source, category, started_at, finished_at, status,
            duration_ms, subrequests, items_count, result_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          task.name,
          task.source ?? null,
          task.category,
          startedAt,
          finishedAt,
          status,
          finishedAt - startedAt,
          extractSubreq(result),
          extractItemsCount(result),
          result ? JSON.stringify(result).slice(0, 4000) : null,
          error,
        )
        .run();
    } catch (logErr) {
      console.error('[cron-runs] insert failed:', logErr);
    }
  }
}

/**
 * Recovery/outbox actions require the observation row itself to be durable.
 * Unlike the general recorder, an insert failure or a classified partial
 * result fails the action after preserving the complete result when possible.
 */
export async function recordCronRunRequired<T>(
  env: Env,
  task: CronTaskMeta,
  fn: () => Promise<T>,
  classifyResultError: (result: T) => string | null = () => null,
  serializeResult: (result: T) => string | Promise<string> = (value) => JSON.stringify(value),
): Promise<T> {
  const startedAt = Date.now();
  let result: T | null = null;
  let taskFailure: unknown;
  try {
    result = await fn();
  } catch (error) {
    taskFailure = error;
  }
  let serializedResult: string | null = null;
  let serializationError: string | null = null;
  if (result != null) {
    try {
      serializedResult = await serializeResult(result);
      if (new TextEncoder().encode(serializedResult).byteLength > 4000
        || serializedResult.includes('"error_code":"CRON_RESULT_OVERSIZE"')) {
        serializationError = 'CRON_RESULT_OVERSIZE';
        serializedResult = JSON.stringify({ status: 'error', error_code: serializationError });
      }
    } catch {
      serializationError = 'CRON_RESULT_SERIALIZATION_FAILED';
      serializedResult = JSON.stringify({ status: 'error', error_code: serializationError });
    }
  }
  const classifiedError = serializationError || (result == null ? null : classifyResultError(result));
  const error = taskFailure
    ? (taskFailure instanceof Error ? `${taskFailure.name}: ${taskFailure.message}` : String(taskFailure))
    : classifiedError;
  const finishedAt = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO cron_runs
         (task_name, source, category, started_at, finished_at, status,
          duration_ms, subrequests, items_count, result_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      task.name,
      task.source ?? null,
      task.category,
      startedAt,
      finishedAt,
      error ? 'error' : 'ok',
      finishedAt - startedAt,
      extractSubreq(result),
      extractItemsCount(result),
      serializedResult,
      error,
    ).run();
  } catch (recordError) {
    throw new Error(`cron_run_record_failed:${task.name}: ${String(recordError)}`);
  }
  if (taskFailure) throw taskFailure;
  if (classifiedError) throw new Error(classifiedError);
  return result as T;
}

function extractSubreq(r: unknown): number | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const candidates: Array<unknown> = [
    o.credits_used,
    o.subrequests_used,
    o.subrequests,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

function extractItemsCount(r: unknown): number | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const candidates: Array<unknown> = [
    o.ingested,
    o.tweets_seen,
    o.refreshed,
    o.fetched_details,
    o.triggered,
    o.found,
    o.items_count,
    o.items,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

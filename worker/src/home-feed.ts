import { toListItem } from './list-item';
import {
  buildListProjection,
  selectProjectedListColumns,
} from './list-query';

export const HOME_FEED_SOURCES = [
  'x_list',
  'blog',
  'podcast',
  'github',
  'product_hunt',
  'hf_paper',
  'huodongxing',
  'clawhub',
  'youtube',
] as const;

const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 12;
const MAX_LIMIT = 48;
const CANDIDATES_PER_SOURCE = 48;
const LEGACY_SOURCE_REPEAT_PENALTY_SECONDS = 10_800;
const FAMILY_REPEAT_PENALTY_SECONDS = 7_200;
const SOURCE_REPEAT_PENALTY_SECONDS = 3_600;
const MAX_HEAT_BONUS_SECONDS = 7_200;
const NEUTRAL_HEAT_BONUS_SECONDS = 3_600;
const CANDIDATE_WINDOW_DAYS = 30;
const MAX_CURSOR_LENGTH = 1_024;
const CURSOR_RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const CURSOR_SQLITE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/;

export type HomeFeedCursor = Readonly<{
  version: 1 | 2;
  asOf: string;
  score: number;
  sortTime: string;
  id: string;
}>;

export type HomeFeedRequest = Readonly<{
  limit: number;
  asOf: string;
  cursor: HomeFeedCursor | null;
}>;

export type HomeFeedQuery = Readonly<{
  sql: string;
  params: unknown[];
}>;

type HomeFeedEnv = Readonly<{
  DB: D1Database;
  HOME_RENDERER_TOKEN?: string;
  WORKFLOW_COMPLETED_FILTER?: string;
}>;

class HomeFeedInputError extends Error {
  constructor() {
    super('Invalid home feed cursor');
    this.name = 'HomeFeedInputError';
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

// Cursor ordering must replay the exact TEXT value emitted by D1. Producers
// currently use both RFC3339 and SQLite-style UTC timestamps, so accept those
// two strict shapes without broadening validation to Date.parse()'s aliases.
function isCursorSortTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const sqliteMatch = CURSOR_SQLITE_DATETIME_PATTERN.exec(value);
  const match = CURSOR_RFC3339_PATTERN.exec(value) ?? sqliteMatch;
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (
    year < 1
    || month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return false;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return local.getUTCFullYear() === year
    && local.getUTCMonth() === month - 1
    && local.getUTCDate() === day
    && local.getUTCHours() === hour
    && local.getUTCMinutes() === minute
    && local.getUTCSeconds() === second
    && Number.isFinite(Date.parse(
      sqliteMatch
        ? `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}Z`
        : value,
    ));
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new HomeFeedInputError();
  }
  const remainder = value.length % 4;
  if (remainder === 1) throw new HomeFeedInputError();
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - remainder) % 4)}`;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new HomeFeedInputError();
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HomeFeedInputError();
  }
}

function validateCursor(value: unknown): HomeFeedCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HomeFeedInputError();
  }
  const cursor = value as Record<string, unknown>;
  if (
    (cursor.version !== 1 && cursor.version !== 2)
    || !isCanonicalIsoDate(cursor.asOf)
    || !Number.isSafeInteger(cursor.score)
    || !isCursorSortTime(cursor.sortTime)
    || typeof cursor.id !== 'string'
    || cursor.id.length < 1
    || cursor.id.length > 512
  ) {
    throw new HomeFeedInputError();
  }
  return {
    version: cursor.version,
    asOf: cursor.asOf,
    score: cursor.score as number,
    sortTime: cursor.sortTime,
    id: cursor.id,
  };
}

function decodeHomeFeedCursor(value: string): HomeFeedCursor {
  try {
    return validateCursor(JSON.parse(decodeBase64Url(value)));
  } catch (error) {
    if (error instanceof HomeFeedInputError) throw error;
    throw new HomeFeedInputError();
  }
}

export function encodeHomeFeedCursor(cursor: HomeFeedCursor): string {
  return encodeBase64Url(JSON.stringify(validateCursor(cursor)));
}

export function parseHomeFeedRequest(
  url: URL,
  nowIso = new Date().toISOString(),
): HomeFeedRequest {
  if (!isCanonicalIsoDate(nowIso)) throw new HomeFeedInputError();

  const rawLimit = url.searchParams.get('limit');
  const parsedLimit = rawLimit === null ? DEFAULT_LIMIT : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsedLimit))
    : DEFAULT_LIMIT;
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor ? decodeHomeFeedCursor(rawCursor) : null;

  return {
    limit,
    asOf: cursor?.asOf ?? nowIso,
    cursor,
  };
}

function candidateSql(workflowCompletedFilter: boolean): string {
  const sourceList = HOME_FEED_SOURCES.map((source) => `'${source}'`).join(', ');
  const workflowCondition = workflowCompletedFilter
    ? "\n          AND (items.source_type != 'x_list' OR json_extract(items.extra, '$.workflow_completed_at') IS NOT NULL)"
    : '';
  return `SELECT id FROM (
        SELECT
          items.id,
          ROW_NUMBER() OVER (
            PARTITION BY items.source_type
            ORDER BY COALESCE(items.published_at, items.scraped_at) DESC, items.id DESC
          ) AS _candidate_rank
        FROM items
        WHERE items.source_type IN (${sourceList})
          AND items.deleted_at IS NULL
          AND items.is_relevant = 1
          AND json_extract(items.extra, '$.dedup_of') IS NULL
          AND COALESCE(json_extract(items.extra, '$.cn_sensitive'), 0) != 1
          AND strftime('%s', COALESCE(items.published_at, items.scraped_at)) <= strftime('%s', ?)
          AND strftime('%s', COALESCE(items.published_at, items.scraped_at)) >= strftime('%s', ?, '-${CANDIDATE_WINDOW_DAYS} days')${workflowCondition}
      )
      WHERE _candidate_rank <= ${CANDIDATES_PER_SOURCE}`;
}

export function buildHomeFeedQuery({
  limit,
  asOf,
  cursor,
  workflowCompletedFilter,
}: HomeFeedRequest & { workflowCompletedFilter: boolean }): HomeFeedQuery {
  const params: unknown[] = [asOf, asOf];

  const cursorWhere = cursor
    ? `AND (
        _home_score < ?
        OR (
          _home_score = ?
          AND (
            _sort_time < ?
            OR (_sort_time = ? AND id < ?)
          )
        )
      )`
    : '';
  if (cursor) {
    params.push(
      cursor.score,
      cursor.score,
      cursor.sortTime,
      cursor.sortTime,
      cursor.id,
    );
  }
  params.push(limit + 1);

  const projected = buildListProjection({
    tableAlias: 'items',
    sourceTypes: HOME_FEED_SOURCES,
  });
  const rankingVersion = cursor?.version ?? 2;
  if (rankingVersion === 1) {
    const rankedColumns = selectProjectedListColumns('ranked');
    const scoredColumns = selectProjectedListColumns('scored');
    const sql = `WITH candidate_ids AS (
      ${candidateSql(workflowCompletedFilter)}
    ),
    ranked AS (
      SELECT
        ${projected},
        COALESCE(items.published_at, items.scraped_at) AS _sort_time,
        CAST(strftime('%s', COALESCE(items.published_at, items.scraped_at)) AS INTEGER) AS _sort_epoch,
        ROW_NUMBER() OVER (
          PARTITION BY items.source_type
          ORDER BY COALESCE(items.published_at, items.scraped_at) DESC, items.id DESC
        ) AS _source_rank
      FROM items
      INNER JOIN candidate_ids ON candidate_ids.id = items.id
    ),
    scored AS (
      SELECT
        ${rankedColumns},
        _sort_time,
        _sort_epoch - ((_source_rank - 1) * ${LEGACY_SOURCE_REPEAT_PENALTY_SECONDS}) AS _home_score
      FROM ranked
    )
    SELECT
      ${scoredColumns},
      _home_score,
      _sort_time
    FROM scored
    WHERE 1 = 1
      ${cursorWhere}
    ORDER BY _home_score DESC, _sort_time DESC, id DESC
    LIMIT ?`;

    return { sql, params };
  }

  // The third frozen asOf parameter is used only for age-normalized heat.
  // Keeping it in the cursor makes percentile replay deterministic.
  params.splice(2, 0, asOf);
  const baseColumns = selectProjectedListColumns('base_ranked');
  const agedColumns = selectProjectedListColumns('aged');
  const signaledColumns = selectProjectedListColumns('signaled');
  const diversifiedColumns = selectProjectedListColumns('diversified');
  const bonusedColumns = selectProjectedListColumns('bonused');
  const scoredColumns = selectProjectedListColumns('scored');

  const sql = `WITH candidate_ids AS (
      ${candidateSql(workflowCompletedFilter)}
    ),
    base_ranked AS (
      SELECT
        ${projected},
        COALESCE(items.published_at, items.scraped_at) AS _sort_time,
        CAST(strftime('%s', COALESCE(items.published_at, items.scraped_at)) AS INTEGER) AS _sort_epoch,
        CAST(strftime('%s', ?) AS INTEGER) AS _as_of_epoch,
        CASE items.source_type
          WHEN 'x_list' THEN 'dynamic'
          WHEN 'github' THEN 'project'
          WHEN 'product_hunt' THEN 'project'
          WHEN 'clawhub' THEN 'project'
          WHEN 'hf_paper' THEN 'research'
          WHEN 'blog' THEN 'official'
          WHEN 'podcast' THEN 'official'
          WHEN 'huodongxing' THEN 'event'
          WHEN 'youtube' THEN 'video'
          ELSE 'dynamic'
        END AS _home_family,
        ROW_NUMBER() OVER (
          PARTITION BY items.source_type
          ORDER BY COALESCE(items.published_at, items.scraped_at) DESC, items.id DESC
        ) AS _source_rank
      FROM items
      INNER JOIN candidate_ids ON candidate_ids.id = items.id
    ),
    aged AS (
      SELECT
        ${baseColumns},
        _sort_time,
        _sort_epoch,
        _home_family,
        _source_rank,
        MAX(0, (_as_of_epoch - _sort_epoch) / 3600.0) AS _age_hours
      FROM base_ranked
    ),
    signaled AS (
      SELECT
        ${agedColumns},
        _sort_time,
        _sort_epoch,
        _home_family,
        _source_rank,
        CASE aged.source_type
          WHEN 'x_list' THEN
            CASE WHEN
              json_type(aged.metrics, '$.likes') IS NOT NULL
              OR json_type(aged.metrics, '$.bookmarks') IS NOT NULL
              OR json_type(aged.metrics, '$.replies') IS NOT NULL
              OR json_type(aged.metrics, '$.retweets') IS NOT NULL
              OR aged.is_hot = 1
            THEN (
              COALESCE(json_extract(aged.metrics, '$.likes'), 0)
              + COALESCE(json_extract(aged.metrics, '$.bookmarks'), 0) * 10
              + COALESCE(json_extract(aged.metrics, '$.replies'), 0) * 13.5
              + COALESCE(json_extract(aged.metrics, '$.retweets'), 0) * 20
              + CASE WHEN aged.is_hot = 1 THEN 25 ELSE 0 END
            ) / (_age_hours + 2)
            ELSE NULL END
          WHEN 'github' THEN
            CASE
              WHEN json_type(aged.metrics, '$.today_stars') IS NOT NULL
                THEN MAX(0, json_extract(aged.metrics, '$.today_stars'))
              WHEN json_type(aged.extra, '$.daily_rank') IS NOT NULL
                THEN MAX(1, 101 - MIN(100, json_extract(aged.extra, '$.daily_rank')))
              ELSE NULL
            END
          WHEN 'product_hunt' THEN
            CASE WHEN
              json_type(aged.metrics, '$.votes') IS NOT NULL
              OR json_type(aged.metrics, '$.comments') IS NOT NULL
            THEN (
              COALESCE(json_extract(aged.metrics, '$.votes'), 0)
              + COALESCE(json_extract(aged.metrics, '$.comments'), 0) * 3
            ) / (_age_hours + 6)
            ELSE NULL END
          WHEN 'hf_paper' THEN
            CASE WHEN
              json_type(aged.metrics, '$.upvotes') IS NOT NULL
              OR json_type(aged.metrics, '$.num_comments') IS NOT NULL
              OR json_type(aged.metrics, '$.github_stars') IS NOT NULL
            THEN (
              COALESCE(json_extract(aged.metrics, '$.upvotes'), 0)
              + COALESCE(json_extract(aged.metrics, '$.num_comments'), 0) * 2
              + COALESCE(json_extract(aged.metrics, '$.github_stars'), 0) * 0.05
            ) / (_age_hours + 6)
            ELSE NULL END
          WHEN 'clawhub' THEN
            CASE WHEN
              json_type(aged.metrics, '$.stars') IS NOT NULL
              OR json_type(aged.metrics, '$.downloads') IS NOT NULL
              OR json_type(aged.metrics, '$.installsCurrent') IS NOT NULL
            THEN (
              COALESCE(json_extract(aged.metrics, '$.stars'), 0) * 10
              + COALESCE(json_extract(aged.metrics, '$.downloads'), 0) * 0.05
              + COALESCE(json_extract(aged.metrics, '$.installsCurrent'), 0) * 2
            ) / (_age_hours + 24)
            ELSE NULL END
          WHEN 'youtube' THEN
            CASE WHEN
              json_type(aged.metrics, '$.views') IS NOT NULL
              OR json_type(aged.metrics, '$.likes') IS NOT NULL
            THEN (
              COALESCE(json_extract(aged.metrics, '$.views'), 0) * 0.01
              + COALESCE(json_extract(aged.metrics, '$.likes'), 0)
            ) / (_age_hours + 6)
            ELSE NULL END
          ELSE NULL
        END AS _heat_signal
      FROM aged
    ),
    diversified AS (
      SELECT
        ${signaledColumns},
        _sort_time,
        _sort_epoch,
        _home_family,
        _source_rank,
        _heat_signal,
        ROW_NUMBER() OVER (
          PARTITION BY _home_family
          ORDER BY _sort_time DESC, id DESC
        ) AS _family_rank,
        COUNT(_heat_signal) OVER (
          PARTITION BY source_type
        ) AS _heat_count,
        RANK() OVER (
          PARTITION BY source_type
          ORDER BY
            CASE WHEN _heat_signal IS NULL THEN 1 ELSE 0 END ASC,
            _heat_signal ASC
        ) AS _heat_rank
      FROM signaled
    ),
    bonused AS (
      SELECT
        ${diversifiedColumns},
        _sort_time,
        _sort_epoch,
        _source_rank,
        _family_rank,
        CASE
          WHEN _heat_signal IS NULL THEN ${NEUTRAL_HEAT_BONUS_SECONDS}
          WHEN _heat_count <= 1 THEN ${NEUTRAL_HEAT_BONUS_SECONDS}
          ELSE CAST(ROUND(
            MIN(${MAX_HEAT_BONUS_SECONDS}, MAX(0,
              ((_heat_rank - 1) * 1.0 / (_heat_count - 1)) * ${MAX_HEAT_BONUS_SECONDS}
            ))
          ) AS INTEGER)
        END AS _heat_bonus
      FROM diversified
    ),
    scored AS (
      SELECT
        ${bonusedColumns},
        _sort_time,
        _sort_epoch
          - ((_family_rank - 1) * ${FAMILY_REPEAT_PENALTY_SECONDS})
          - ((_source_rank - 1) * ${SOURCE_REPEAT_PENALTY_SECONDS})
          + _heat_bonus AS _home_score
      FROM bonused
    )
    SELECT
      ${scoredColumns},
      _home_score,
      _sort_time
    FROM scored
    WHERE 1 = 1
      ${cursorWhere}
    ORDER BY _home_score DESC, _sort_time DESC, id DESC
    LIMIT ?`;

  return { sql, params };
}

export function isHomeRendererRequest(
  request: Request,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken || request.method !== 'GET') return false;
  const url = new URL(request.url);
  return (
    url.pathname === '/api/home-feed'
    && request.headers.get('X-Home-Renderer-Token') === configuredToken
  );
}

function jsonResponse(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function handleHomeFeed(
  request: Request,
  env: HomeFeedEnv,
  nowIso = new Date().toISOString(),
): Promise<Response> {
  if (!isHomeRendererRequest(request, env.HOME_RENDERER_TOKEN)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }

  let parsed: HomeFeedRequest;
  try {
    parsed = parseHomeFeedRequest(new URL(request.url), nowIso);
  } catch (error) {
    if (error instanceof HomeFeedInputError) {
      return jsonResponse({ error: 'invalid_cursor' }, 400);
    }
    throw error;
  }

  const query = buildHomeFeedQuery({
    ...parsed,
    workflowCompletedFilter: env.WORKFLOW_COMPLETED_FILTER === 'true',
  });
  const result = await env.DB.prepare(query.sql).bind(...query.params).all();
  const rows = (result.results ?? []) as Record<string, unknown>[];
  const hasMore = rows.length > parsed.limit;
  const visibleRows = rows.slice(0, parsed.limit);
  const lastRow = hasMore ? visibleRows.at(-1) : undefined;
  const rankingVersion = parsed.cursor?.version ?? 2;
  const nextCursor = lastRow
    && Number.isSafeInteger(lastRow._home_score)
    && isCursorSortTime(lastRow._sort_time)
    && typeof lastRow.id === 'string'
    ? encodeHomeFeedCursor({
      version: rankingVersion,
      asOf: parsed.asOf,
      score: lastRow._home_score as number,
      sortTime: lastRow._sort_time,
      id: lastRow.id,
    })
    : null;
  const duration = typeof result.meta?.duration === 'number' && Number.isFinite(result.meta.duration)
    ? Math.max(0, result.meta.duration)
    : 0;

  return jsonResponse({
    view_mode: 'waterfall',
    ranking_version: rankingVersion,
    items: visibleRows.map((row) => toListItem(row)),
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: duration,
    generated_at: parsed.asOf,
  }, 200, {
    'Server-Timing': `d1;dur=${duration}`,
  });
}

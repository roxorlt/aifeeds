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
] as const;

const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 12;
const MAX_LIMIT = 48;
const CANDIDATES_PER_SOURCE = 48;
const SOURCE_REPEAT_PENALTY_SECONDS = 10_800;
const CANDIDATE_WINDOW_DAYS = 30;
const MAX_CURSOR_LENGTH = 1_024;

export type HomeFeedCursor = Readonly<{
  version: 1;
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
    cursor.version !== 1
    || !isCanonicalIsoDate(cursor.asOf)
    || !Number.isSafeInteger(cursor.score)
    || !isCanonicalIsoDate(cursor.sortTime)
    || typeof cursor.id !== 'string'
    || cursor.id.length < 1
    || cursor.id.length > 512
  ) {
    throw new HomeFeedInputError();
  }
  return {
    version: 1,
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

function candidateSql(
  source: typeof HOME_FEED_SOURCES[number],
  workflowCompletedFilter: boolean,
): string {
  const workflowCondition = source === 'x_list' && workflowCompletedFilter
    ? "\n          AND json_extract(items.extra, '$.workflow_completed_at') IS NOT NULL"
    : '';
  return `SELECT id FROM (
        SELECT items.id
        FROM items
        WHERE items.source_type = '${source}'
          AND items.deleted_at IS NULL
          AND items.is_relevant = 1
          AND json_extract(items.extra, '$.dedup_of') IS NULL
          AND COALESCE(json_extract(items.extra, '$.cn_sensitive'), 0) != 1
          AND strftime('%s', COALESCE(items.published_at, items.scraped_at)) <= strftime('%s', ?)
          AND strftime('%s', COALESCE(items.published_at, items.scraped_at)) >= strftime('%s', ?, '-${CANDIDATE_WINDOW_DAYS} days')${workflowCondition}
        ORDER BY COALESCE(items.published_at, items.scraped_at) DESC, items.id DESC
        LIMIT ${CANDIDATES_PER_SOURCE}
      )`;
}

export function buildHomeFeedQuery({
  limit,
  asOf,
  cursor,
  workflowCompletedFilter,
}: HomeFeedRequest & { workflowCompletedFilter: boolean }): HomeFeedQuery {
  const candidateParts = HOME_FEED_SOURCES.map((source) => (
    candidateSql(source, workflowCompletedFilter)
  ));
  const params: unknown[] = [];
  for (let index = 0; index < HOME_FEED_SOURCES.length; index += 1) {
    params.push(asOf, asOf);
  }

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
  const rankedColumns = selectProjectedListColumns('ranked');
  const scoredColumns = selectProjectedListColumns('scored');

  const sql = `WITH candidate_ids AS (
      ${candidateParts.join('\n      UNION ALL\n      ')}
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
        _sort_epoch - ((_source_rank - 1) * ${SOURCE_REPEAT_PENALTY_SECONDS}) AS _home_score
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
  const nextCursor = lastRow
    && Number.isSafeInteger(lastRow._home_score)
    && isCanonicalIsoDate(lastRow._sort_time)
    && typeof lastRow.id === 'string'
    ? encodeHomeFeedCursor({
      version: 1,
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
    items: visibleRows.map((row) => toListItem(row)),
    next_cursor: nextCursor,
    has_more: hasMore,
    query_time_ms: duration,
    generated_at: parsed.asOf,
  }, 200, {
    'Server-Timing': `d1;dur=${duration}`,
  });
}

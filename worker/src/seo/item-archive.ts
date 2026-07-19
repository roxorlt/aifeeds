import {
  ITEM_CN_NOT_SENSITIVE_SQL,
  ITEM_NOT_DEDUPED_SQL,
} from './item-page-policy';

export const ARCHIVE_SOURCES = ['x', 'gh', 'ph', 'paper', 'news'] as const;
export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];

export const ARCHIVE_PAGE_SIZE = 100;
export const MAX_ARCHIVE_PAGE = 10_000;

export type ItemArchiveRoute =
  | { kind: 'index' }
  | { kind: 'source'; source: ArchiveSource }
  | { kind: 'month'; source: ArchiveSource; month: string; page: number };

export interface ArchiveItemRow {
  id: string;
  source: string;
  url_path: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
}

const SOURCE_SET = new Set<string>(ARCHIVE_SOURCES);
const PAGE_SOURCE: Record<ArchiveSource, string> = {
  x: 'x',
  gh: 'gh',
  ph: 'ph',
  paper: 'hf-paper',
  news: 'news',
};
const ARCHIVE_EFFECTIVE_TIME = "COALESCE(NULLIF(i.published_at, ''), i.scraped_at)";
export const ITEM_ELIGIBILITY = `i.is_relevant = 1
        AND i.deleted_at IS NULL
        AND ${ITEM_NOT_DEDUPED_SQL}
        AND ${ITEM_CN_NOT_SENSITIVE_SQL}`;
export const ITEM_PAGE_ELIGIBILITY = `p.status = 'live'
        AND ${ITEM_ELIGIBILITY}`;

// 一个公开 url_path 只能对应一个 canonical。PH 可能在不同日期重复上榜，但公开路由
// `/i/ph/:slug` 会选择 published_at 最新的 item；所有 sitemap / archive 查询必须使用
// 同一代表行，否则同一 URL 会重复出现，且月份、分页计数会互相漂移。
// 只有 PH 允许多个 item 共享公开 url_path，因此窗口严格限制在 PH 子集；其他四源沿用
// 直接查询，避免每个归档请求都对 3 万+ X 行做无意义的窗口排序。
function canonicalPhItemPagesCte(sourceBinding: boolean): string {
  const sourceFilter = sourceBinding
    ? 'i.source_type = ?'
    : "i.source_type = 'product_hunt'";
  return `WITH canonical_ph_item_pages AS (
      SELECT i.id, p.source, p.url_path, i.title, i.author,
        ${ARCHIVE_EFFECTIVE_TIME} AS published_at,
        p.generated_at, p.status,
        ROW_NUMBER() OVER (
          PARTITION BY substr(i.id, 14, instr(substr(i.id, 14), ':') - 1)
          ORDER BY CASE WHEN p.status = 'live' THEN 0 ELSE 1 END ASC,
            ${ARCHIVE_EFFECTIVE_TIME} DESC, i.id DESC
        ) AS canonical_rank
      FROM items i
      LEFT JOIN item_pages p ON p.item_id = i.id
      WHERE ${sourceFilter} AND
        ${ITEM_ELIGIBILITY}
        AND (p.status = 'live' OR p.status IS NULL)
    )`;
}

export const ARCHIVE_SOURCE_LABELS: Record<ArchiveSource, string> = {
  x: 'X 精选',
  gh: 'GitHub 项目',
  ph: 'Product Hunt',
  paper: 'AI 论文',
  news: '官方新闻',
};

export function archivePageSource(source: ArchiveSource): string {
  return PAGE_SOURCE[source];
}

export function isArchiveMonth(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match || match[1] === '0000') return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function archiveSource(value: string): ArchiveSource | null {
  return SOURCE_SET.has(value) ? (value as ArchiveSource) : null;
}

function archivePage(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= MAX_ARCHIVE_PAGE ? page : null;
}

export function parseItemArchivePath(pathname: string): ItemArchiveRoute | null {
  if (pathname === '/archive' || pathname === '/archive/') return { kind: 'index' };

  const sourceMatch = pathname.match(/^\/archive\/([^/]+)\/?$/);
  if (sourceMatch) {
    const source = archiveSource(sourceMatch[1]);
    return source ? { kind: 'source', source } : null;
  }

  const monthMatch = pathname.match(/^\/archive\/([^/]+)\/([^/]+)\/?$/);
  if (monthMatch) {
    const source = archiveSource(monthMatch[1]);
    if (!source || !isArchiveMonth(monthMatch[2])) return null;
    return { kind: 'month', source, month: monthMatch[2], page: 1 };
  }

  const pageMatch = pathname.match(/^\/archive\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!pageMatch) return null;
  const source = archiveSource(pageMatch[1]);
  const page = archivePage(pageMatch[3]);
  if (!source || !isArchiveMonth(pageMatch[2]) || page == null) return null;
  return { kind: 'month', source, month: pageMatch[2], page };
}

export function archiveCanonicalPath(route: ItemArchiveRoute): string {
  if (route.kind === 'index') return '/archive/';
  if (route.kind === 'source') return `/archive/${route.source}/`;
  const base = `/archive/${route.source}/${route.month}/`;
  return route.page === 1 ? base : `${base}${route.page}`;
}

export function archiveItemsQuery(
  source: ArchiveSource,
  month: string,
  page: number,
): { sql: string; bindings: [string, string, number, number] } {
  if (!isArchiveMonth(month)) throw new Error('invalid archive month');
  if (!Number.isInteger(page) || page < 1 || page > MAX_ARCHIVE_PAGE) {
    throw new Error('invalid archive page');
  }

  const offset = (page - 1) * ARCHIVE_PAGE_SIZE;
  const canonicalPh = source === 'ph';
  return {
    sql: canonicalPh
      ? `${canonicalPhItemPagesCte(true)}
      SELECT id, source, url_path, title, author, published_at
      FROM canonical_ph_item_pages
      WHERE canonical_rank = 1 AND status = 'live'
        AND substr(published_at, 1, 7) = ?
      ORDER BY published_at DESC, id DESC
      LIMIT ? OFFSET ?`
      : `SELECT i.id, p.source, p.url_path, i.title, i.author,
             ${ARCHIVE_EFFECTIVE_TIME} AS published_at
      FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE p.source = ? AND substr(${ARCHIVE_EFFECTIVE_TIME}, 1, 7) = ?
        AND ${ITEM_PAGE_ELIGIBILITY}
      ORDER BY ${ARCHIVE_EFFECTIVE_TIME} DESC, i.id DESC
      LIMIT ? OFFSET ?`,
    bindings: [
      canonicalPh ? 'product_hunt' : PAGE_SOURCE[source],
      month,
      ARCHIVE_PAGE_SIZE,
      offset,
    ],
  };
}

export function archiveMonthsQuery(
  source: ArchiveSource,
): { sql: string; bindings: [string] } {
  if (source !== 'ph') {
    return {
      sql: `SELECT substr(${ARCHIVE_EFFECTIVE_TIME}, 1, 7) AS month, COUNT(*) AS item_count
        FROM items i
        JOIN item_pages p ON p.item_id = i.id
        WHERE p.source = ?
          AND ${ITEM_PAGE_ELIGIBILITY}
          AND ${ARCHIVE_EFFECTIVE_TIME} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'
        GROUP BY month
        ORDER BY month DESC`,
      bindings: [PAGE_SOURCE[source]],
    };
  }
  return {
    sql: `${canonicalPhItemPagesCte(true)}
      SELECT substr(published_at, 1, 7) AS month, COUNT(*) AS item_count
      FROM canonical_ph_item_pages
      WHERE canonical_rank = 1 AND status = 'live'
        AND published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'
      GROUP BY month
      ORDER BY month DESC`,
    bindings: ['product_hunt'],
  };
}

export function archiveCountQuery(
  source: ArchiveSource,
  month: string,
): { sql: string; bindings: [string, string] } {
  if (!isArchiveMonth(month)) throw new Error('invalid archive month');
  if (source !== 'ph') {
    return {
      sql: `SELECT COUNT(*) AS item_count
        FROM items i
        JOIN item_pages p ON p.item_id = i.id
        WHERE p.source = ? AND substr(${ARCHIVE_EFFECTIVE_TIME}, 1, 7) = ?
          AND ${ITEM_PAGE_ELIGIBILITY}`,
      bindings: [PAGE_SOURCE[source], month],
    };
  }
  return {
    sql: `${canonicalPhItemPagesCte(true)}
      SELECT COUNT(*) AS item_count
      FROM canonical_ph_item_pages
      WHERE canonical_rank = 1 AND status = 'live'
        AND substr(published_at, 1, 7) = ?`,
    bindings: ['product_hunt', month],
  };
}

export function archiveSitemapGroupsQuery(): { sql: string; bindings: [] } {
  return {
    sql: `${canonicalPhItemPagesCte(false)},
      canonical_item_pages AS (
        SELECT p.source, ${ARCHIVE_EFFECTIVE_TIME} AS published_at, p.generated_at
        FROM items i
        JOIN item_pages p ON p.item_id = i.id
        WHERE p.source <> 'ph' AND ${ITEM_PAGE_ELIGIBILITY}
        UNION ALL
        SELECT source, published_at, generated_at
        FROM canonical_ph_item_pages
        WHERE canonical_rank = 1 AND status = 'live'
      )
      SELECT source, substr(published_at, 1, 7) AS month,
             COUNT(*) AS item_count, MAX(generated_at) AS lastmod
      FROM canonical_item_pages
      WHERE published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'
      GROUP BY source, month
      ORDER BY source ASC, month DESC`,
    bindings: [],
  };
}

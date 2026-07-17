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
  return {
    sql: `SELECT i.id, p.source, p.url_path, i.title, i.author, i.published_at
      FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE p.source = ? AND substr(i.published_at, 1, 7) = ?
        AND p.status = 'live'
        AND i.is_relevant = 1
        AND i.deleted_at IS NULL
        AND json_extract(i.extra, '$.dedup_of') IS NULL
        AND COALESCE(json_extract(i.extra, '$.cn_sensitive'), 0) != 1
      ORDER BY i.published_at DESC, i.id DESC
      LIMIT ? OFFSET ?`,
    bindings: [PAGE_SOURCE[source], month, ARCHIVE_PAGE_SIZE, offset],
  };
}

const ARCHIVE_ELIGIBILITY = `p.status = 'live'
        AND i.is_relevant = 1
        AND i.deleted_at IS NULL
        AND json_extract(i.extra, '$.dedup_of') IS NULL
        AND COALESCE(json_extract(i.extra, '$.cn_sensitive'), 0) != 1`;

export function archiveMonthsQuery(
  source: ArchiveSource,
): { sql: string; bindings: [string] } {
  return {
    sql: `SELECT substr(i.published_at, 1, 7) AS month, COUNT(*) AS item_count
      FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE p.source = ?
        AND ${ARCHIVE_ELIGIBILITY}
        AND i.published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'
      GROUP BY month
      ORDER BY month DESC`,
    bindings: [PAGE_SOURCE[source]],
  };
}

export function archiveCountQuery(
  source: ArchiveSource,
  month: string,
): { sql: string; bindings: [string, string] } {
  if (!isArchiveMonth(month)) throw new Error('invalid archive month');
  return {
    sql: `SELECT COUNT(*) AS item_count
      FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE p.source = ? AND substr(i.published_at, 1, 7) = ?
        AND ${ARCHIVE_ELIGIBILITY}`,
    bindings: [PAGE_SOURCE[source], month],
  };
}

export function archiveSitemapGroupsQuery(): { sql: string; bindings: [] } {
  return {
    sql: `SELECT p.source, substr(i.published_at, 1, 7) AS month,
             COUNT(*) AS item_count, MAX(p.generated_at) AS lastmod
      FROM items i
      JOIN item_pages p ON p.item_id = i.id
      WHERE ${ARCHIVE_ELIGIBILITY}
        AND i.published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'
      GROUP BY p.source, month
      ORDER BY p.source ASC, month DESC`,
    bindings: [],
  };
}

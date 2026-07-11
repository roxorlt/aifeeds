import {
  SOURCE_EXTRA_ALLOWLISTS,
  type ListItemSourceType,
} from './list-item';

export type ListProjectionSource = ListItemSourceType;

// Columns that cross the D1 -> Worker boundary for a list row. Detail-only
// bookkeeping columns are intentionally absent; score/state aliases are added
// explicitly by the handler that owns the corresponding cursor contract.
export const LIST_ROW_COLUMNS = [
  'id',
  'source_type',
  'source_id',
  'source_ref',
  'title',
  'content',
  'content_translated',
  'author',
  'handle',
  'url',
  'media',
  'metrics',
  'published_at',
  'scraped_at',
  'is_relevant',
  'is_hot',
  'matched_by',
  'lang',
  'extra',
] as const;

type ProjectionOptions = {
  tableAlias?: string;
  sourceTypes?: readonly ListProjectionSource[];
};

export type HiddenListProjection = Readonly<{
  alias: `_${string}`;
  expression: string;
}>;

type SelectOptions = ProjectionOptions & {
  additional?: readonly HiddenListProjection[];
};

type ExtraFieldSpec = {
  key: string;
  sourcePath?: string;
  valueSql?: (tableAlias: string) => string;
};

const ALL_PROJECTION_SOURCES = Object.freeze(
  Object.keys(SOURCE_EXTRA_ALLOWLISTS) as ListProjectionSource[],
);
const PROJECTION_SOURCE_SET = new Set<string>(ALL_PROJECTION_SOURCES);

export function isListProjectionSource(value: string): value is ListProjectionSource {
  return PROJECTION_SOURCE_SET.has(value);
}

export function filterListProjectionSources(
  values: readonly string[],
): ListProjectionSource[] {
  return values.filter(isListProjectionSource);
}

const HEAVY_CONTENT_SOURCES = new Set<ListProjectionSource>([
  'clawhub',
  'blog',
  'podcast',
]);

const HIDDEN_EXTRA_FIELDS: Readonly<Partial<Record<ListProjectionSource, readonly ExtraFieldSpec[]>>> = {
  // Keep README only as a hidden derivation input until the approved backfill
  // proves every row has either cover_url or cover_status='none'. toListItem()
  // derives cover_url and never serializes these hidden fields.
  github: [
    { key: 'cover_url' },
    { key: 'cover_status' },
    { key: 'default_branch' },
    {
      key: 'readme_excerpt',
      valueSql: (alias) => (
        `CASE WHEN json_extract(${alias}.extra, '$.cover_status') IN ('ok', 'none') `
        + `THEN NULL ELSE json_extract(${alias}.extra, '$.readme_excerpt') END`
      ),
    },
  ],
  hf_paper: [
    {
      key: 'deep_analysis',
      sourcePath: '$.deep_analysis.tldr',
      valueSql: (alias) => (
        `json_object('tldr', json_extract(${alias}.extra, '$.deep_analysis.tldr'))`
      ),
    },
  ],
  blog: [
    boundedExtraText('excerpt'),
    boundedExtraText('excerpt_zh'),
  ],
  podcast: [
    boundedExtraText('excerpt'),
    boundedExtraText('excerpt_zh'),
    boundedExtraText('shownotes'),
    boundedExtraText('shownotes_zh'),
  ],
};

const X_ARTICLE_HEAVY_PATHS = [
  '$.article_id',
  '$.body',
  '$.body_translated',
  '$.body_fetched_at',
  '$.body_fetch_failed_at',
  '$.body_translate_skipped_at',
  '$.summary_text',
  '$.translated_at',
  '$.translate_failed_at',
] as const;

function boundedExtraText(key: string): ExtraFieldSpec {
  return {
    key,
    valueSql: (alias) => `substr(json_extract(${alias}.extra, '$.${key}'), 1, 280)`,
  };
}

function quoteHeavyPaths(): string[] {
  const paths: string[] = [];
  for (const path of X_ARTICLE_HEAVY_PATHS) {
    paths.push(`$.x_article${path.slice(1)}`);
    paths.push(`$.quote_of.x_article${path.slice(1)}`);
  }
  return paths;
}

function jsonRemoveExpression(value: string, paths: readonly string[]): string {
  return `json_remove(${value}, ${paths.map((path) => `'${path}'`).join(', ')})`;
}

function xFieldValueSql(key: string, alias: string): string | null {
  const value = `json_extract(${alias}.extra, '$.${key}')`;
  if (key === 'x_article') {
    return jsonRemoveExpression(value, X_ARTICLE_HEAVY_PATHS);
  }
  if (key === 'quote_of' || key === 'retweet_of') {
    return jsonRemoveExpression(value, quoteHeavyPaths());
  }
  if (key === 'reply_of') {
    return jsonRemoveExpression(
      value,
      X_ARTICLE_HEAVY_PATHS.map((path) => `$.x_article${path.slice(1)}`),
    );
  }
  return null;
}

function sourceExtraSpecs(sourceType: ListProjectionSource): ExtraFieldSpec[] {
  const visibleFields = Object.prototype.hasOwnProperty.call(
    SOURCE_EXTRA_ALLOWLISTS,
    sourceType,
  )
    ? SOURCE_EXTRA_ALLOWLISTS[sourceType]
    : [];
  const hidden = Object.prototype.hasOwnProperty.call(HIDDEN_EXTRA_FIELDS, sourceType)
    ? HIDDEN_EXTRA_FIELDS[sourceType] ?? []
    : [];
  const visible = visibleFields.map((key) => ({ key }));
  const byKey = new Map<string, ExtraFieldSpec>();
  for (const field of [...visible, ...hidden]) byKey.set(field.key, field);
  return [...byKey.values()];
}

function compactExtraSql(sourceType: ListProjectionSource, alias: string): string {
  const specs = sourceExtraSpecs(sourceType);
  if (specs.length === 0) return `json_object()`;

  const pairs: string[] = [];
  const removals: string[] = [];
  specs.forEach((spec, index) => {
    const sourcePath = spec.sourcePath ?? `$.${spec.key}`;
    const specialX = sourceType === 'x_list' ? xFieldValueSql(spec.key, alias) : null;
    const value = spec.valueSql?.(alias)
      ?? specialX
      ?? `json_extract(${alias}.extra, '${sourcePath}')`;
    pairs.push(`'${spec.key}', ${value}`);
    // json_type distinguishes a missing path (SQL NULL) from an explicit JSON
    // null ('null'), preserving the latter for existing card fallbacks.
    removals.push(
      `CASE WHEN json_type(${alias}.extra, '${sourcePath}') IS NULL `
      + `THEN '$.${spec.key}' ELSE '$.__keep_${index}' END`,
    );
  });

  return `json_remove(json_object(${pairs.join(', ')}), ${removals.join(', ')})`;
}

function contentSql(
  column: 'content' | 'content_translated',
  alias: string,
  sourceTypes: readonly ListProjectionSource[] | undefined,
): string {
  const value = `${alias}.${column}`;
  if (sourceTypes && sourceTypes.length === 0) return value;
  if (sourceTypes?.length === 1) {
    return HEAVY_CONTENT_SOURCES.has(sourceTypes[0])
      ? `substr(${value}, 1, 280)`
      : value;
  }
  if (sourceTypes && sourceTypes.every((source) => HEAVY_CONTENT_SOURCES.has(source))) {
    return `substr(${value}, 1, 280)`;
  }
  const relevantHeavy = sourceTypes
    ? sourceTypes.filter((source) => HEAVY_CONTENT_SOURCES.has(source))
    : [...HEAVY_CONTENT_SOURCES];
  if (relevantHeavy.length === 0) return value;
  const sourceList = relevantHeavy.map((source) => `'${source}'`).join(', ');
  return `CASE WHEN ${alias}.source_type IN (${sourceList}) `
    + `THEN substr(${value}, 1, 280) ELSE ${value} END`;
}

function extraSql(
  alias: string,
  sourceTypes: readonly ListProjectionSource[] | undefined,
): string {
  if (sourceTypes && sourceTypes.length === 0) return `json_object()`;
  if (sourceTypes?.length === 1) return compactExtraSql(sourceTypes[0], alias);
  const cases = (sourceTypes?.length ? sourceTypes : ALL_PROJECTION_SOURCES)
    .map((source) => `WHEN '${source}' THEN ${compactExtraSql(source, alias)}`)
    .join(' ');
  return `CASE ${alias}.source_type ${cases} ELSE json_object() END`;
}

export function buildListProjection({
  tableAlias = 'items',
  sourceTypes,
}: ProjectionOptions = {}): string {
  const baseColumns = LIST_ROW_COLUMNS
    .filter((column) => column !== 'extra')
    .map((column) => {
      if (column === 'content' || column === 'content_translated') {
        return `${contentSql(column, tableAlias, sourceTypes)} AS ${column}`;
      }
      return `${tableAlias}.${column} AS ${column}`;
    });
  baseColumns.push(`${extraSql(tableAlias, sourceTypes)} AS extra`);
  return baseColumns.join(',\n      ');
}

export function buildListSelect({
  tableAlias = 'items',
  sourceTypes,
  additional = [],
}: SelectOptions = {}): string {
  const hidden = additional.map(({ alias, expression }) => {
    if (!/^_[A-Za-z][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(`invalid hidden list alias: ${alias}`);
    }
    return `${expression} AS ${alias}`;
  });
  const suffix = hidden.length > 0 ? `,\n      ${hidden.join(',\n      ')}` : '';
  return `SELECT ${buildListProjection({ tableAlias, sourceTypes })}${suffix}`;
}

export function selectProjectedListColumns(tableAlias = 'sub'): string {
  return LIST_ROW_COLUMNS.map((column) => `${tableAlias}.${column}`).join(',\n      ');
}

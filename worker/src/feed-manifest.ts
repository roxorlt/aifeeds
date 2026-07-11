type LiveSourceRow = {
  source_type: string;
};

const PUBLIC_FEED_SOURCES = [
  { source_type: 'x_list', label: '动态' },
  { source_type: 'blog', label: '新闻' },
  { source_type: 'podcast', label: '播客' },
  { source_type: 'product_hunt', label: '热门产品' },
  { source_type: 'github', label: '开源项目' },
  { source_type: 'hf_paper', label: '论文' },
  { source_type: 'huodongxing', label: '活动' },
  { source_type: 'clawhub', label: '龙虾技能' },
  { source_type: 'youtube', label: 'YouTube' },
] as const;

type PublicFeedSourceType = typeof PUBLIC_FEED_SOURCES[number]['source_type'];

export interface FeedManifest {
  live_source_types: PublicFeedSourceType[];
  labels: Partial<Record<PublicFeedSourceType, string>>;
  generated_at: string;
}

const PUBLIC_SOURCE_TYPES = PUBLIC_FEED_SOURCES.map(({ source_type }) => source_type);
const PUBLIC_SOURCE_TYPE_SET = new Set<string>(PUBLIC_SOURCE_TYPES);
const SOURCE_LABELS = new Map<PublicFeedSourceType, string>(
  PUBLIC_FEED_SOURCES.map(({ source_type, label }) => [source_type, label]),
);

export async function buildFeedManifest(
  db: D1Database,
  now: () => Date = () => new Date(),
): Promise<FeedManifest> {
  const placeholders = PUBLIC_SOURCE_TYPES.map(() => '?').join(', ');
  const liveSources = await db.prepare(`
    SELECT source_type
    FROM items
    WHERE is_relevant = 1
      AND deleted_at IS NULL
      AND source_type IN (${placeholders})
    GROUP BY source_type
    ORDER BY source_type ASC
  `).bind(...PUBLIC_SOURCE_TYPES).all<LiveSourceRow>();

  const liveSourceTypes = [...new Set(
    liveSources.results
      .map((row) => row.source_type)
      .filter((sourceType): sourceType is PublicFeedSourceType => PUBLIC_SOURCE_TYPE_SET.has(sourceType)),
  )];
  const labels: Partial<Record<PublicFeedSourceType, string>> = {};
  for (const sourceType of liveSourceTypes) {
    labels[sourceType] = SOURCE_LABELS.get(sourceType);
  }

  return {
    live_source_types: liveSourceTypes,
    labels,
    generated_at: now().toISOString(),
  };
}

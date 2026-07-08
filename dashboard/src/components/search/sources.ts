// 「按来源浏览」源清单（source 均 ∈ worker/src/search/handlers.ts LEGAL_SOURCES）。
// label/icon 口径跟随 App.tsx 顶栏频道；「新闻&播客」在 items 表是复合频道值
// "blog,podcast"，但 search source 参数只吃单值，故此处拆成「新闻」(blog) 与
// 「播客」(podcast) 两枚，其余与频道一致。放独立文件（非组件），避免 react-refresh
// only-export-components 告警。
export const BROWSE_SOURCES: { source: string; label: string }[] = [
  { source: "x_list", label: "动态" },
  { source: "blog", label: "新闻" },
  { source: "podcast", label: "播客" },
  { source: "product_hunt", label: "热门产品" },
  { source: "github", label: "开源项目" },
  { source: "hf_paper", label: "论文" },
  { source: "huodongxing", label: "活动" },
  { source: "clawhub", label: "龙虾技能" },
  { source: "youtube", label: "YouTube" },
];

// 结果分组可能出现 BROWSE_SOURCES 之外的合法源（worker LEGAL_SOURCES 含 arxiv /
// weibo，但不作为「按来源浏览」入口），补一张兜底表让组头/单源页头有中文名。
const EXTRA_SOURCE_LABELS: Record<string, string> = {
  arxiv: "arXiv",
  weibo: "微博",
};

// 源 → 中文名（scope chip / 结果组头 / 单源页头复用）。未知源回退原值。
export function browseSourceLabel(source: string): string {
  return (
    BROWSE_SOURCES.find((s) => s.source === source)?.label ??
    EXTRA_SOURCE_LABELS[source] ??
    source
  );
}

// 分组结果页组序权威表：与 App.tsx 的 SOURCE_COLUMNS（feed 列序）保持一致。
// ⚠️ 改一处必须同步另一处 —— feed 列增删/调序时，这张表要跟着改。
// blog/podcast 同属「新闻&播客」列（feed 里合并为一列），blog 排 podcast 前，
// 故取相邻权重（10/11）。未列出的合法源（weibo/arxiv 等）走缺省 999 落末尾。
export const SOURCE_FEED_ORDER: Record<string, number> = {
  x_list: 0,
  blog: 10,
  podcast: 11,
  product_hunt: 20,
  github: 30,
  hf_paper: 40,
  huodongxing: 50,
  clawhub: 60,
  youtube: 70,
};

// 查 feed 列序权重，未知源缺省 999（落到末尾）。
export function sourceFeedOrder(st: string): number {
  return SOURCE_FEED_ORDER[st] ?? 999;
}

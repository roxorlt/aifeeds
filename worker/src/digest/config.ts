// 订阅推送子系统配置(运营可调)。设计文档:roxor-main-design-20260528-090625.md
//
// 改推送节点:这里 PUSH_SLOTS_BJT 加 1 个值 + wrangler.toml [triggers] 加 1 个 cron。
// 改每源条数:改 SOURCE_DIGEST_CONFIG。新增源:加进 DIGEST_SOURCE_ORDER + SOURCE_DIGEST_CONFIG。

// 平台固定推送节点(BJT 小时),MVP 3 个。每个 email 最多选 1 个,变更覆盖式。
export const PUSH_SLOTS_BJT = [8, 12, 17] as const;

// 订阅推送源固定展示顺序(邮件内分区 + 勾选界面)。活动行 huodongxing 不参与订阅推送。
// 'news'(行业新闻=blog+podcast 合并)2026-06-21 加入,固定排第一位 = 邮件头条;它是强制板块
// (deliver.ts 对所有订阅者强制包含,不参与勾选界面),其余 4 源(clawhub 已下架)按用户订阅。
export const DIGEST_SOURCE_ORDER = ['news', 'ph', 'gh', 'hf-paper', 'clawhub', 'x'] as const;
export type DigestSource = (typeof DIGEST_SOURCE_ORDER)[number];

export type Density = 'normal' | 'curated';

// 每源在两档下各取多少条。normal=默认档(纯综合分);curated=精选档(LLM 从更大候选挑)。
export const SOURCE_DIGEST_CONFIG: Record<DigestSource, { normal: number; curated: number }> = {
  'news': { normal: 5, curated: 3 }, // 行业新闻:规则分(非 LLM)默认档 top 5 / 精选档 top 3;Codex 8 点推送读 normal 档=5 条。见 selection.ts selectNewsByScore + node-run 跳过 curate
  'ph': { normal: 5, curated: 3 },
  'gh': { normal: 5, curated: 3 },
  'hf-paper': { normal: 5, curated: 3 },
  'clawhub': { normal: 3, curated: 1 }, // 按 24h star 增量取(非累积 top),见 selection.ts
  'x': { normal: 3, curated: 2 },
};

// curated 候选池:LLM 从 normal 榜 top CURATED_CANDIDATE_POOL 里挑 M 条。
export const CURATED_CANDIDATE_POOL = 30;

// 每日静态日报页:每个源在页面上最多展示的条数(Task 2/3 消费,与订阅推送 SOURCE_DIGEST_CONFIG 独立)。
export const DAILY_PAGE_PER_SOURCE_LIMIT = 20;

// BJT 节点小时 → UTC 小时(BJT = UTC+8)。8→0, 12→4, 17→9。cron 表达式用 UTC。
export function slotBjtToUtcHour(bjtHour: number): number {
  return (bjtHour - 8 + 24) % 24;
}

// ── 入参校验(订阅/管理接口共用)──

export function isValidSlot(slot: unknown): slot is number {
  return typeof slot === 'number' && (PUSH_SLOTS_BJT as readonly number[]).includes(slot);
}

export function isValidDensity(d: unknown): d is Density {
  return d === 'normal' || d === 'curated';
}

export function isValidSources(arr: unknown): arr is DigestSource[] {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const valid = new Set<string>(DIGEST_SOURCE_ORDER);
  return (
    arr.every((s) => typeof s === 'string' && valid.has(s)) &&
    new Set(arr).size === arr.length
  );
}

// 按 DIGEST_SOURCE_ORDER 规范化勾选的源(过滤非法 + 去重 + 固定顺序)
export function normalizeSources(sources: DigestSource[]): DigestSource[] {
  return DIGEST_SOURCE_ORDER.filter((s) => sources.includes(s));
}

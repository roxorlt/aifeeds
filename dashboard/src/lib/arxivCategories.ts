// arxiv categories 中文映射 — 卡片右上角分类下拉筛选用。
// 完整列表见 https://arxiv.org/category_taxonomy(800+ 个),这里只列 AI/ML 相关
// 高频 category(覆盖 HF Daily Papers 99% 论文)。其他 category fallback 显原代码。
//
// BE Phase 1 把 extra.arxiv_categories: string[] 字段入库后,FE 用此表做显示映射。
// 主分类(primary)取 extra.arxiv_categories[0],下拉只列 primary 维度(避免下拉过长)。

const ARXIV_CATEGORY_ZH: Record<string, string> = {
  // Computer Science(cs.*)— HF Daily 高频
  "cs.AI": "人工智能",
  "cs.LG": "机器学习",
  "cs.CL": "自然语言",
  "cs.CV": "计算机视觉",
  "cs.NE": "神经计算",
  "cs.IR": "信息检索",
  "cs.RO": "机器人",
  "cs.MA": "多智能体",
  "cs.GR": "计算机图形",
  "cs.HC": "人机交互",
  "cs.SD": "音频处理",
  "cs.CR": "密码与安全",
  "cs.DC": "分布式计算",
  "cs.DS": "数据结构与算法",
  "cs.SE": "软件工程",

  // Statistics
  "stat.ML": "统计学习",
  "stat.AP": "应用统计",
  "stat.ME": "统计方法",

  // Math
  "math.OC": "优化与控制",
  "math.PR": "概率论",
  "math.ST": "统计数学",

  // Physics
  "physics.comp-ph": "计算物理",
  "physics.data-an": "物理数据分析",

  // Quantitative Biology
  "q-bio.NC": "神经科学",
  "q-bio.QM": "定量方法",

  // Electrical Engineering and Systems Science
  "eess.IV": "图像视频处理",
  "eess.AS": "音频信号",
  "eess.SP": "信号处理",
  "eess.SY": "系统与控制",
};

/**
 * arxiv category code → 中文标签。未知 code 直接返回原值(如 `cs.LO`)。
 * 显示格式建议:`cs.LG · 机器学习`(下拉框 option label)或 `机器学习`(chip)。
 */
export function arxivCategoryLabel(code: string): string {
  return ARXIV_CATEGORY_ZH[code] || code;
}

/**
 * 完整选项格式 `code · 中文`,用于下拉框 option 显示。
 */
export function arxivCategoryOptionLabel(code: string): string {
  const zh = ARXIV_CATEGORY_ZH[code];
  return zh ? `${code} · ${zh}` : code;
}

/**
 * 从一组 papers 的 categories 字段聚合 unique primary categories,按出现次数排序。
 * 用于动态生成下拉选项(只展示当前流里实际有的分类)。
 */
export function aggregatePrimaryCategories(
  papers: Array<{ arxiv_categories?: string[] }>,
): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of papers) {
    const primary = p.arxiv_categories?.[0];
    if (!primary) continue;
    counts.set(primary, (counts.get(primary) || 0) + 1);
  }
  return Array.from(counts, ([code, count]) => ({ code, count })).sort(
    (a, b) => b.count - a.count,
  );
}

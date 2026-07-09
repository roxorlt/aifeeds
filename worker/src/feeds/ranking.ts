export interface FeedNewsRankInput {
  id: string;
  title: string;
  sourceType: string;
  sourceKey: string;
  sourceCompany: string;
  aiCategory: string;
  publishedAt: string;
  hasSummary: boolean;
  hasBody: boolean;
  heat?: number;
}

export interface FeedNewsRankResult extends FeedNewsRankInput {
  total: number;
  breakdown: {
    relevance: number;
    freshness: number;
    sourceAuthority: number;
    impact: number;
    heat: number;
    completeness: number;
    industryPerson: number;
  };
  industryPeople: string[];
}

export const INDUSTRY_PERSON_TITLE_BOOST = 12;

const industryPeople = [
  { label: '李飞飞', terms: ['李飞飞', 'fei-fei li', 'feifei li'] },
  { label: 'Dario Amodei', terms: ['dario amodei', 'amodei', '达里奥', '达里奥·阿莫迪', '阿莫迪'] },
  { label: 'Sam Altman', terms: ['sam altman', 'altman', '奥特曼'] },
  { label: 'Ilya Sutskever', terms: ['ilya sutskever', 'sutskever', '伊利亚', '苏茨克维'] },
  { label: 'Jensen Huang', terms: ['jensen huang', '黄仁勋'] },
  { label: 'Andrew Ng', terms: ['andrew ng', '吴恩达'] },
  { label: 'Yann LeCun', terms: ['yann lecun', 'lecun', '杨立昆'] },
  { label: 'Demis Hassabis', terms: ['demis hassabis', 'hassabis', '哈萨比斯'] },
  { label: 'Geoffrey Hinton', terms: ['geoffrey hinton', 'hinton', '辛顿'] },
  { label: 'Andrej Karpathy', terms: ['andrej karpathy', 'karpathy', '卡帕西'] },
  { label: 'Mira Murati', terms: ['mira murati', 'murati', '穆拉蒂'] },
  { label: 'Elon Musk', terms: ['elon musk', 'musk', '马斯克'] },
  { label: 'Mark Zuckerberg', terms: ['mark zuckerberg', 'zuckerberg', '扎克伯格'] },
  { label: 'Sundar Pichai', terms: ['sundar pichai', 'pichai', '皮查伊'] },
  { label: 'Satya Nadella', terms: ['satya nadella', 'nadella', '纳德拉'] },
  { label: 'Robin Li', terms: ['robin li', '李彦宏'] },
  { label: '梁文锋', terms: ['梁文锋', 'liang wenfeng'] },
  { label: '李开复', terms: ['李开复', 'kai-fu lee', 'kaifu lee'] },
];

export function detectIndustryPersonMentions(title: string): string[] {
  const text = normalizeTitle(title);
  const matched: string[] = [];
  for (const person of industryPeople) {
    if (person.terms.some((term) => text.includes(normalizeTitle(term)))) {
      matched.push(person.label);
    }
  }
  return matched;
}

export function scoreFeedNewsItemForOrdering(item: FeedNewsRankInput, nowMs = Date.now()): FeedNewsRankResult {
  const industryPeople = detectIndustryPersonMentions(item.title);
  const breakdown = {
    relevance: relevanceScore(item.aiCategory),
    freshness: freshnessScore(item.publishedAt, item.sourceKey, nowMs),
    sourceAuthority: sourceAuthorityScore(item.sourceCompany, item.sourceKey),
    impact: impactScore(item.title, item.aiCategory),
    heat: heatScore(item.heat),
    completeness: completenessScore(item),
    industryPerson: industryPeople.length > 0 ? INDUSTRY_PERSON_TITLE_BOOST : 0,
  };
  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { ...item, total, breakdown, industryPeople };
}

export function feedNewsRankSqlExpression(nowSql = "'now'"): string {
  const titlePersonLike = industryPeople
    .flatMap((person) => person.terms)
    .map((term) => `lower(title) LIKE '%${escapeSqlLike(normalizeTitle(term))}%'`)
    .join(' OR ');

  return `(
    ${relevanceSql()} +
    ${freshnessSql(nowSql)} +
    ${sourceAuthoritySql()} +
    ${impactSql()} +
    ${heatSql()} +
    ${completenessSql()} +
    CASE WHEN ${titlePersonLike} THEN ${INDUSTRY_PERSON_TITLE_BOOST} ELSE 0 END
  )`;
}

function relevanceScore(category: string): number {
  if (category === 'model-release') return 28;
  if (category === 'research') return 24;
  if (category === 'product') return 22;
  if (category === 'engineering') return 18;
  if (category === 'safety') return 16;
  if (category === 'company') return 12;
  return 6;
}

function freshnessScore(publishedAt: string, sourceKey: string, nowMs: number): number {
  const publishedMs = Date.parse(publishedAt || '');
  if (!Number.isFinite(publishedMs)) return 2;
  const ageHours = Math.max(0, (nowMs - publishedMs) / 3_600_000);
  const halfLifeHours = sourceKey === 'weibo-hot-tech' ? 8 : 24;
  return 35 / Math.pow(ageHours / halfLifeHours + 1, 1.25);
}

function sourceAuthorityScore(company: string, sourceKey: string): number {
  if (sourceKey === 'weibo-hot-tech') return 8;
  const companyNorm = normalizeAuthorityName(company);
  const sourceKeyNorm = normalizeAuthorityName(sourceKey);
  if (firstPartyModelSourceNames.has(companyNorm) || firstPartyModelSourceNames.has(sourceKeyNorm)) return 10;
  if (techMediaSourceNames.has(companyNorm) || techMediaSourceNames.has(sourceKeyNorm)) return 9;
  return 7;
}

function impactScore(title: string, category: string): number {
  const text = normalizeTitle(title);
  let score = 0;
  if (category === 'model-release') score += 6;
  if (/发布|推出|release|launch|unveil|开源|open source/.test(text)) score += 5;
  if (/融资|收购|acquire|funding|ipo|估值/.test(text)) score += 3;
  if (/芯片|算力|gpu|robot|机器人|agent|模型|model|deepseek|openai|anthropic|google|nvidia|豆包|qwen|通义|千问|腾讯|tencent|混元|hunyuan|hy3|百度|baidu|文心|ernie|智谱|zhipu|glm|kimi|moonshot|minimax|美团|longcat|百川|baichuan|阶跃|stepfun|商汤|sense|讯飞|spark|星火|天工|tiangong|书生|internlm/.test(text)) score += 4;
  return Math.min(10, score);
}

function heatScore(value: number | undefined): number {
  if (!value || value <= 0) return 0;
  return Math.min(10, Math.log10(value + 1) * 1.8);
}

function completenessScore(item: FeedNewsRankInput): number {
  let score = 0;
  if (item.hasSummary) score += 3;
  if (item.hasBody) score += 2;
  return score;
}

function normalizeTitle(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeAuthorityName(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const firstPartyModelSourceNames = new Set([
  'openai', 'anthropic', 'google', 'googleresearch', 'microsoftresearch', 'microsoft',
  'nvidia', 'deepmind', 'googledeepmind', 'huggingface', 'meta', 'mistral', 'cohere',
  'perplexity', 'xai', 'ai21', 'cerebras', 'groq',
  // 国内模型厂商 / 一手模型源。这里故意覆盖厂商名、模型家族名、常见 feed_key。
  'deepseek',
  'tencent', '腾讯', 'tencenthunyuan', 'hunyuan', '混元',
  'alibaba', '阿里', '阿里巴巴', 'qwen', '通义', '通义千问',
  'baidu', '百度', 'ernie', '文心',
  'bytedance', '字节', '字节跳动', 'volcengine', '火山引擎', 'doubao', '豆包',
  'zhipu', '智谱', 'zhipuai', 'glm',
  'moonshot', '月之暗面', 'kimi',
  'minimax',
  'meituan', '美团', 'longcat',
  'baichuan', '百川',
  'stepfun', '阶跃星辰', '阶跃',
  '01ai', '零一万物', '零一',
  'sense', 'sensetime', '商汤', '日日新',
  'iflytek', '科大讯飞', '讯飞', 'spark', '星火',
  'kunlun', 'kunlunwanwei', '昆仑万维', 'tiangong', '天工',
  'modelbest', '面壁', 'internlm', '书生', '上海人工智能实验室',
]);

const techMediaSourceNames = new Set([
  'techcrunch', 'theverge', 'mittechnologyreview',
  '量子位', '新智元', '机器之心',
]);

function escapeSqlLike(value: string): string {
  return value.replace(/'/g, "''").replace(/[%_]/g, (m) => `\\${m}`);
}

function relevanceSql(): string {
  return `(CASE json_extract(extra, '$.ai_category')
    WHEN 'model-release' THEN 28
    WHEN 'research' THEN 24
    WHEN 'product' THEN 22
    WHEN 'engineering' THEN 18
    WHEN 'safety' THEN 16
    WHEN 'company' THEN 12
    ELSE 6
  END)`;
}

function freshnessSql(nowSql: string): string {
  return `(35.0 / POW(
    ((julianday(${nowSql}) - julianday(published_at)) * 24) /
    (CASE WHEN COALESCE(source_ref, json_extract(extra, '$.feed_key')) = 'weibo-hot-tech' THEN 8.0 ELSE 24.0 END)
    + 1,
    1.25
  ))`;
}

function sourceAuthoritySql(): string {
  return `(CASE
    WHEN COALESCE(source_ref, json_extract(extra, '$.feed_key')) = 'weibo-hot-tech' THEN 8
    WHEN json_extract(extra, '$.source_company') IN ('OpenAI','Anthropic','Google','Microsoft Research','NVIDIA','DeepMind','Hugging Face') THEN 10
    WHEN json_extract(extra, '$.source_company') IN ('TechCrunch','The Verge','MIT Technology Review','量子位','新智元','机器之心') THEN 9
    ELSE 7
  END)`;
}

function impactSql(): string {
  return `MIN(10, (CASE WHEN json_extract(extra, '$.ai_category') = 'model-release' THEN 6 ELSE 0 END
    + CASE WHEN title LIKE '%发布%' OR title LIKE '%推出%' OR lower(title) LIKE '%release%' OR lower(title) LIKE '%launch%' OR lower(title) LIKE '%unveil%' OR title LIKE '%开源%' OR lower(title) LIKE '%open source%' THEN 5 ELSE 0 END
    + CASE WHEN title LIKE '%融资%' OR title LIKE '%收购%' OR lower(title) LIKE '%acquire%' OR lower(title) LIKE '%funding%' OR lower(title) LIKE '%ipo%' OR title LIKE '%估值%' THEN 3 ELSE 0 END
    + CASE WHEN title LIKE '%芯片%' OR title LIKE '%算力%' OR lower(title) LIKE '%gpu%' OR lower(title) LIKE '%robot%' OR title LIKE '%机器人%' OR lower(title) LIKE '%agent%' OR title LIKE '%模型%' OR lower(title) LIKE '%model%' OR lower(title) LIKE '%deepseek%' OR lower(title) LIKE '%openai%' OR lower(title) LIKE '%anthropic%' OR lower(title) LIKE '%google%' OR lower(title) LIKE '%nvidia%' OR title LIKE '%豆包%' OR lower(title) LIKE '%qwen%' OR title LIKE '%通义%' THEN 4 ELSE 0 END
  ))`;
}

function heatSql(): string {
  return `(CASE
    WHEN COALESCE(CAST(json_extract(metrics, '$.likes') AS INTEGER), 0) > 0
      THEN MIN(10, log(COALESCE(CAST(json_extract(metrics, '$.likes') AS INTEGER), 0) + 1) * 1.8)
    ELSE 0
  END)`;
}

function completenessSql(): string {
  return `(CASE WHEN json_extract(extra, '$.ai_summary_zh') IS NOT NULL THEN 3 ELSE 0 END
    + CASE WHEN json_extract(extra, '$.body_markdown') IS NOT NULL OR json_extract(extra, '$.transcript_text') IS NOT NULL THEN 2 ELSE 0 END)`;
}

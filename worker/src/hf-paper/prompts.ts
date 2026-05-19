// HF Paper 8 段 deep_analysis prompts + title/summary 翻译 prompt
//
// 设计文档 §5.1(C 方案):每段独立 pro reasoning 调用 + 1 次 flash translate,
// 共 8 段输出(limitations + novelty_rating 合一段,需全局判断论文价值)
//
// User 决策(2026-05-18):"按最佳质量来设计方案,成本不考虑"
// 实测月度成本估算 ¥17-42/月(50 paper × 30 天 × 8 段 reasoning + flash)

// ────────────────────────────────────────────────────────────────────
// Shared context builder(每段调用都带)
// ────────────────────────────────────────────────────────────────────

export interface DeepAnalyzeContext {
  title: string;
  summary: string;                                // 英文 abstract
  ai_summary_en?: string;                         // HF 生成的一句话摘要
  ai_keywords?: string[];
  arxiv_categories?: string[];
  github_url?: string | null;
  github_stars?: number | null;
  project_page?: string | null;
  ar5iv_excerpt?: string | null;                  // ar5iv 前 3000 字段落
}

export function buildBaseContext(ctx: DeepAnalyzeContext): string {
  const lines: string[] = [];
  lines.push('【输入】');
  lines.push(`- title: ${ctx.title}`);
  lines.push(`- summary: ${ctx.summary}`);
  if (ctx.ai_summary_en) lines.push(`- ai_summary_en: ${ctx.ai_summary_en}`);
  if (ctx.ai_keywords && ctx.ai_keywords.length > 0) {
    lines.push(`- ai_keywords: ${ctx.ai_keywords.slice(0, 20).join(', ')}`);
  }
  if (ctx.arxiv_categories && ctx.arxiv_categories.length > 0) {
    lines.push(`- arxiv_categories: ${ctx.arxiv_categories.join(', ')}`);
  }
  if (ctx.github_url) lines.push(`- github_url: ${ctx.github_url}`);
  if (typeof ctx.github_stars === 'number') lines.push(`- github_stars: ${ctx.github_stars}`);
  if (ctx.project_page) lines.push(`- project_page: ${ctx.project_page}`);
  if (ctx.ar5iv_excerpt) {
    lines.push('');
    lines.push('【论文正文摘录(ar5iv 前部分)】');
    lines.push(ctx.ar5iv_excerpt.slice(0, 3000));
  }
  return lines.join('\n');
}

const SHARED_INTRO = `你是 AI 论文解读专家。

【受众】全球 AI 行业从业者(算法工程师 / 研究员 / 产品经理 / 技术决策者),共同语言是 AI 技术,不分国别。
【输出语言】简体中文,质量达到中文母语者阅读习惯的流畅度(自然的中文句式 + 合理的中英混排空格 + 专有名词保留英文)。
【⚠️ 严禁地域化措辞】不要出现以下任何字眼或类似变体:"中国 / 国内 / 中国从业者 / 中国 AI 从业者 / 国内同行 / 国内厂商 / 国内业界 / 中文社区 / 国人"。"用中文写"≠"面向中国读者";受众是全球 AI 行业,只是用中文阅读。任何举例 / 类比 / 应用场景都不带地域前缀。`;

const SHARED_RULES = `【翻译规则】
- 专有名词(模型 / 数据集 / 方法名)保留英文,例:Transformer / NeRSemble / FLAME / LoRA
- 中英混合句中,英文术语前后留空格,例:"使用 LoRA 微调"
- 代码 / 公式原文保留
- 风格:正式但易懂,避免 "重磅" / "突破" / "震撼" / "最强" 等营销腔
- AI 工程视角:每段必须有"对实际工程的启示"或"跟同类工作的差异"(不限定地域,不写"对中国 / 国内从业者而言"这类窄化表述)
- 严禁堆砌动词形容词凑字数;200-500 字必须有信息密度

【markdown 排版要求】(PM 反馈大块文字不利阅读,各段 string 字段必须 markdown 结构化):
- 内部合理分段,段落之间空行分隔
- **关键概念**用粗体标(模型名 / 数据集 / 指标 / 核心创新)
- 列表组织对比 / 步骤 / 要点(- bullet 或 1. 2. 3.)
- 行内代码 \`identifier\`(变量 / 函数 / 配置 / arxiv id 等)
- 必要时用 > blockquote 强调引用 / 原作者论断
- 用 ### 三级标题 切大段(单段 > 300 字时建议)
- 必要时用表格 | col1 | col2 | 做指标 / 对比
- 外部链接 [文字](url) 引用 GH / 项目主页 / 论文 / blog
- ⚠️ 不要包整段在 \`\`\`markdown\`\`\` block 内,直接输出原始 markdown

【⚠️ markdown 中文边界规则】(react-markdown / CommonMark flanking 解析限制):
- **粗体后必须接空格或全角标点**(不能直接接中文字)
  - ✅ \`**激活操控** 是一种...\` / \`**激活操控**(activation steering)\` / \`**激活操控**,xxx\`
  - ❌ \`**激活操控**是一种...\`(中文紧贴会让 ** 不解析为粗体)
- 行内 code 同样规则:\`\`identifier\` 后接空格 / 标点 / 换行
- 全角括号 \`(...)\` 内可放粗体,但右括号 \`)\` 后还是要空格或标点接中文
- 链接 [文字](url) 同样后空格或标点

只输出 JSON,JSON 内的 string 值是 markdown 文本。不要 markdown 代码块包裹整个 JSON。不要解释。`;

// ────────────────────────────────────────────────────────────────────
// 8 段 deep_analysis prompts(每段独立 pro reasoning JSON Mode 调用)
// ────────────────────────────────────────────────────────────────────

export type DimensionKey =
  | 'tldr'
  | 'problem'
  | 'key_insight'
  | 'method'
  | 'experiments'
  | 'industry_impact'
  | 'code_status'
  | 'limitations_and_novelty';

interface DimensionSpec {
  key: DimensionKey;
  instruction: string;          // dimension-specific 写作要求
  schemaExample: string;        // JSON schema 示例(指导模型输出格式)
  maxTokens: number;            // 输出 max(含 reasoning,pro 单段建议 3000-5000)
}

export const DIMENSIONS: Record<DimensionKey, DimensionSpec> = {
  tldr: {
    key: 'tldr',
    instruction: `【任务:tldr】
一句/两句话核心(30-80 字),作为 drawer 顶部 callout。
要求:读完这一句就懂这论文做什么 + 为什么牛;避免抽象套话(如"提出了一种新方法")。`,
    schemaExample: `{"version":"v1","tldr":"<30-80 字>"}`,
    maxTokens: 2000,
  },
  problem: {
    key: 'problem',
    instruction: `【任务:problem】
200-500 字。结构:
- 问题背景(~50 字):这个领域当前关注什么
- 现有方法局限(~150 字):为啥老办法不够好(具体技术 limitation,不要泛泛而谈)
- 为什么这个问题难/重要(~150 字):技术挑战 + 业界关注度
- 1 句行业类比(~50 字):跟某个具体 AI 应用场景关联(不带地域前缀)`,
    schemaExample: `{"version":"v1","problem":"<200-500 字>"}`,
    maxTokens: 3500,
  },
  key_insight: {
    key: 'key_insight',
    instruction: `【任务:key_insight】
1-3 条独立 bullet,每条 80-200 字。结构:
- 先一句话定义这个 insight(粗体的话不用 markdown,纯文本)
- 再用一段话解释为什么这个角度独特(跟同类工作 / 已有 baseline 的差异)
不要硬凑 3 条,1-2 条精准的更好。`,
    schemaExample: `{"version":"v1","key_insight":["<insight 1,80-200 字>", "<insight 2>"]}`,
    maxTokens: 3500,
  },
  method: {
    key: 'method',
    instruction: `【任务:method】
200-500 字方法详解。结构:
- 按"输入 → 关键模块 → 输出"线索叙述
- 允许技术术语(架构名 / 损失函数 / 训练技巧)但避免数学公式(用文字描述)
- 末尾 1 句"跟同类方法的差异点"
**ar5iv_excerpt 一定要读**(若提供),不要只看 abstract 凭想象写。`,
    schemaExample: `{"version":"v1","method":"<200-500 字>"}`,
    maxTokens: 4000,
  },
  experiments: {
    key: 'experiments',
    instruction: `【任务:experiments】
结构化 + narrative 两部分。
- datasets:数据集名(string[],≤5,例 ["NeRSemble","FLAME-data"])
- key_metrics:{name, value, vs_baseline} 数组(≤5,严禁捏造数字,没把握返空数组)
  例:[{"name":"PSNR","value":"+5.5","vs_baseline":"↑ vs LAM"}]
- compute:训练算力(20 字内,例 "8×A100 7天" / "单 A100 推理 2 秒")
- narrative:实验设计叙述(~150 字)+ 关键发现(~200 字)+ 跟基线对比的深度解读(~150 字),共 200-500 字`,
    schemaExample: `{"version":"v1","experiments":{"datasets":["..."],"key_metrics":[{"name":"...","value":"...","vs_baseline":"..."}],"compute":"...","narrative":"<200-500 字>"}}`,
    maxTokens: 4000,
  },
  industry_impact: {
    key: 'industry_impact',
    instruction: `【任务:industry_impact】
200-500 字工业界影响分析。结构:
- 落地场景(~150 字):哪些产品 / 业务能用
- 商业价值(~150 字):降本 / 增收 / 体验提升 哪条线
- 跟现有产品/工作流的接口(~150 字):怎么集成进现有 stack
**具体落地 use case**:必须举 1-2 个真实 AI 行业场景(电商 / 内容平台 / 教育 / 医疗 / 金融 / 自动驾驶 / 企业服务 等);**不带地域前缀**(不写"国内电商 / 中国教育"等)。`,
    schemaExample: `{"version":"v1","industry_impact":"<200-500 字>"}`,
    maxTokens: 4000,
  },
  code_status: {
    key: 'code_status',
    instruction: `【任务:code_status】
结构化 + narrative。
- github_url:从输入复用 github_url 字段(不要造,没有就 null)
- star_count:从输入复用 github_stars(没有就 null)
- license:从 GH/README 推断,无信息就 "unknown"(常见:MIT / Apache-2.0 / GPL-3.0 / BSD)
- reproducibility:**easy**(单 GPU + 公开数据)/ **medium**(多 GPU + 部分私有数据)/ **hard**(大集群 + 完全私有数据)
- narrative:复现难度理由(~100 字)+ 数据/算力门槛(~100 字)+ 训练 vs 推理代价(~100 字),共 100-300 字`,
    schemaExample: `{"version":"v1","code_status":{"github_url":null,"star_count":null,"license":"unknown","reproducibility":"medium","narrative":"<100-300 字>"}}`,
    maxTokens: 3000,
  },
  limitations_and_novelty: {
    key: 'limitations_and_novelty',
    instruction: `【任务:limitations + novelty_rating(合并,需全局判断)】
先输出 limitations,再用 limitations 的视角给 novelty_rating。

- limitations:1-3 条 bullet,每条 100-200 字
  - 论文承认的局限(abstract / discussion 一般会写)
  - 可推断的局限(从方法 / 实验设计看出的弱点)
  - 跟同类工作对比的弱点
- novelty_rating:**严格 1-5 整数**(不能 4.5),按下表评:
  - 5: 开创新方向(罕见,如首个 Transformer / DDPM / RLHF 论文)
  - 4: 重要改进,业内必看(如 LoRA / FlashAttention / Mistral)
  - 3: 稳健工作,某细分领域 SOTA
  - 2: 渐进改进,补充已有方法
  - 1: 数据集 / 综述 / 复现工作`,
    schemaExample: `{"version":"v1","limitations":["<局限 1,100-200 字>"],"novelty_rating":3}`,
    maxTokens: 3500,
  },
};

/**
 * 拼完整 prompt 给指定 dimension
 */
export function buildDimensionPrompt(
  dimension: DimensionKey,
  ctx: DeepAnalyzeContext,
): { prompt: string; maxTokens: number } {
  const spec = DIMENSIONS[dimension];
  const baseCtx = buildBaseContext(ctx);
  const prompt = `${SHARED_INTRO}

${baseCtx}

${spec.instruction}

${SHARED_RULES}

【输出 JSON schema 示例(只参考结构,内容自己写)】
${spec.schemaExample}`;
  return { prompt, maxTokens: spec.maxTokens };
}

// ────────────────────────────────────────────────────────────────────
// title / summary / ai_summary 翻译 prompt(flash JSON Mode,Step 3 flash 段)
// ────────────────────────────────────────────────────────────────────

export function buildTitleSummaryPrompt(ctx: {
  title: string;
  summary: string;
  ai_summary_en?: string;
  ai_keywords?: string[];
}): string {
  return `你是论文标题翻译助手。

【输入】
- title: ${ctx.title}
- summary: ${ctx.summary}
${ctx.ai_summary_en ? `- ai_summary_en: ${ctx.ai_summary_en}` : ''}
${ctx.ai_keywords && ctx.ai_keywords.length > 0 ? `- paper_keywords: ${ctx.ai_keywords.slice(0, 20).join(', ')}` : ''}

【任务】输出 JSON:
{
  "title_zh": "<标题中译,保留专有名词英文,不带任何 markdown>",
  "summary_zh": "<abstract 中译,200-400 字,**markdown 格式**(见排版要求)>",
  "ai_summary_zh": "<HF ai_summary 中译,30 字内,不带 markdown>"
}

【翻译规则】专有名词保留英文(参考 paper_keywords),中英混合留空格。

【summary_zh markdown 排版要求】(PM 反馈大块文字不利阅读,要求结构化):
- 合理分段(2-4 段),每段聚焦一个层面(问题 / 方法 / 实验 / 结论 等)
- **关键概念**用粗体标(模型名 / 数据集 / 指标 / 创新点)
- 必要时用列表组织对比或要点(- bullet 或 1. 2. 3.)
- 段落之间空行分隔
- 不用 # 标题(summary 篇幅短,标题反而碎)
- 行内代码 \`identifier\`(变量名 / 函数名 / 配置项)

【⚠️ markdown 中文边界规则】(react-markdown / CommonMark flanking 解析限制):
- **粗体后必须接空格或全角标点**(不能直接接中文字),否则 ** 不被解析为粗体
  - ✅ \`**激活操控** 是一种...\` / \`**激活操控**(steering)\` / \`**激活操控**,xxx\`
  - ❌ \`**激活操控**是一种...\`(中文「是」紧贴会让 ** 不解析为粗体)
- 行内 code 同样规则:\`\`code\` 后接空格 / 标点 / 换行

只输出 JSON,不要 markdown 代码块包裹整个 JSON。`;
}

// ar5iv 段落级翻译 prompt 已弃用(2026-05-19 PM 决策方案 E)— FE iframe arxiv.org/html
// 用户用浏览器翻译插件实时翻;BE 不再做。

// ────────────────────────────────────────────────────────────────────
// 评论翻译 prompt(flash,batch 调用)
// ────────────────────────────────────────────────────────────────────

export interface CommentToTranslate {
  id: string;
  author: string;
  content: string;
}

export function buildCommentsTranslatePrompt(opts: {
  paper_title: string;
  comments: CommentToTranslate[];
}): string {
  const list = opts.comments
    .map((c) => `  { "id": "${c.id}", "author": "${c.author}", "content": ${JSON.stringify(c.content)} }`)
    .join(',\n');
  return `你是论文评论区翻译助手。

【输入】
- paper_title: ${opts.paper_title}
- comments: [
${list}
  ]

【任务】每条评论翻译为简体中文,输出 JSON:
{
  "translations": [
    { "id": "<原 id>", "content_zh": "<译文,支持 markdown>" }
  ]
}

【规则】
- 保留 @username / #hashtag / URL 原文
- 专有名词英文(参考 paper_title)
- 口语化(学术评论常用 colloquial 语言)
- 代码 / 公式原文保留(行内 \`code\` / 代码块 \`\`\`...\`\`\`)
- emoji 保留
- 已是中文的评论 content_zh 仍输出原文(便于 FE 统一渲染)
- 翻译保留原 markdown 元素(列表 / 加粗 / 链接等),原文有则保留

只输出 JSON,不要 markdown 包裹整个 JSON。`;
}

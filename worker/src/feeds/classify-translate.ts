// worker/src/feeds/classify-translate.ts
//
// DeepSeek flash 上的 is_ai 判别 + ELI25 翻译（§8.4，JSON Mode / 纯文本）。
// 复用现网 DeepSeek client 调用方式（github.ts 的 system+user+response_format）+
// hf-paper/llm.ts 的 gateway URL / 模型常量。
//
//   - isAiGate（§8.4.0）：step1 廉价前置 gate，只判 is_relevant + confidence（最频繁调用）。
//     纯判别不落库；DB 写由 pipeline 的 quick-classify step 负责。
//   - reclassifyOnFulltext（§8.1）：step3 末尾全文复判（终判），落 is_relevant。
//   - classifyAndTranslateForFeeds（§8.4.A）：step4 eager 合并 enrich+翻译，不再判 is_relevant。
//   - translateBodyMarkdown（§8.4.B）：step4 lazy 全文 ELI25 翻译，fenced/inline code 不译。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §8

import type { Env } from "../index";
import { DEEPSEEK_FLASH, DEEPSEEK_PRO, DEEPSEEK_URL } from "../hf-paper/llm";
import type { FeedAiCategory, FeedKind, FeedLang } from "./types";

const LLM_TIMEOUT_MS = 60_000;
const AI_CATEGORIES: ReadonlySet<string> = new Set([
  "model-release",
  "research",
  "product",
  "engineering",
  "safety",
  "company",
  "other",
]);

// 去掉新闻标题开头的栏目 / 推广标签前缀:[AINews]、[Exclusive]、【独家】 等。
// 这些标签是源站原标题自带的(如 smol.ai newsletter),直译会原样带进来,降低可读性。
// 仅剥「开头、短(≤24 字)、方括号 [] 或中文方括号 【】」的标签段,可连续多个;
// 圆括号 () 不剥(常含有意义的限定词);剥完过短(<4 字)则放弃,防把纯标签标题清空。
// 新 prompt 已要求 LLM 自行去前缀,这里是渲染层 + 存量老标题的兜底防线。
export function stripLabelPrefix(s: string): string {
  let t = (s || "").trim();
  const re = /^\s*[\[【][^\]】\n]{1,24}[\]】]\s*[:：–—-]?\s*/;
  for (let i = 0; i < 4; i++) {
    const stripped = t.replace(re, "").trim();
    if (!stripped || stripped.length < 4 || stripped === t) break;
    t = stripped;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek 调用（system+user；JSON / 纯文本两种）— 1 次 retry
// ─────────────────────────────────────────────────────────────────────────────

async function callRaw(
  env: Env,
  system: string,
  user: string,
  opts: { maxTokens: number; jsonMode: boolean; model?: string },
): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) {
    console.warn("[feeds-llm] DEEPSEEK_API_KEY missing — skip");
    return null;
  }
  const body: Record<string, unknown> = {
    model: opts.model || DEEPSEEK_FLASH,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: opts.maxTokens,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const r = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!r.ok) {
        console.error(`[feeds-llm] HTTP ${r.status}`);
        continue;
      }
      const data = await r.json<{
        choices?: { message?: { content?: string } }[];
      }>();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      console.warn(`[feeds-llm] attempt ${attempt + 1} fail`, e);
    }
  }
  return null;
}

async function callJson<T>(
  env: Env,
  system: string,
  user: string,
  maxTokens: number,
  model: string = DEEPSEEK_FLASH,
): Promise<T | null> {
  const text = await callRaw(env, system, user, { maxTokens, jsonMode: true, model });
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error(`[feeds-llm] JSON parse fail: ${text.slice(0, 300)}`);
    return null;
  }
}

/** json_set 多路径写 extra（路径 + 值都 bind，防 SQL 注入 + 防 lost-update）。
 *  json:true → 值用 json(?) 解析回 JSON（写数组/对象，如 guests string[]）。 */
async function jsonSetExtra(
  env: Env,
  itemId: string,
  pairs: Array<{ path: string; value: unknown; json?: boolean }>,
): Promise<void> {
  if (!pairs.length) return;
  const setExpr = pairs.map((p) => (p.json ? "?, json(?)" : "?, ?")).join(", ");
  const binds: unknown[] = [];
  for (const p of pairs) {
    binds.push(p.path);
    binds.push(p.json ? JSON.stringify(p.value) : p.value);
  }
  binds.push(itemId);
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(COALESCE(extra, '{}'), ${setExpr}) WHERE id = ?`,
  )
    .bind(...binds)
    .run();
}

interface ItemRow {
  title: string | null;
  content: string | null;
  extra: string | null;
  is_relevant: number | null;
}

export interface FeedEventFingerprint {
  event_type: string;
  primary_actor: string;
  primary_object: string;
  object_family: string;
  object_variant: string;
  object_version: string;
  action: string;
  canonical_event: string;
  confidence: number;
}

export function normalizeFeedEventFingerprint(value: unknown): FeedEventFingerprint | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const raw = obj[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 120);
    }
    return "";
  };
  const eventType = pick("event_type", "eventType").replace(/-/g, "_");
  const canonical = pick("canonical_event", "canonicalEvent");
  const primaryObject = pick("primary_object", "primaryObject");
  if (!eventType || (!canonical && !primaryObject)) return null;
  const confidence = Number(obj.confidence);
  return {
    event_type: eventType,
    primary_actor: pick("primary_actor", "primaryActor"),
    primary_object: primaryObject,
    object_family: pick("object_family", "objectFamily"),
    object_variant: pick("object_variant", "objectVariant"),
    object_version: pick("object_version", "objectVersion"),
    action: pick("action").replace(/-/g, "_"),
    canonical_event: canonical || primaryObject,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
  };
}

async function loadItem(env: Env, itemId: string): Promise<{
  title: string;
  content: string;
  extra: Record<string, unknown>;
  is_relevant: number | null;
}> {
  const row = await env.DB.prepare(
    `SELECT title, content, extra, is_relevant FROM items WHERE id = ?`,
  )
    .bind(itemId)
    .first<ItemRow>();
  if (!row) throw new Error(`classify-translate: item not found ${itemId}`);
  return {
    title: row.title || "",
    content: row.content || "",
    extra: row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {},
    is_relevant: row.is_relevant,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.4.0 — step1 廉价 is_ai gate（is_relevant-only）
// ─────────────────────────────────────────────────────────────────────────────

const GATE_SYSTEM =
  "你是 AI 资讯的相关性判别器，服务一个面向中国 AI 从业者的聚合 feed。只判断「这条内容是否与 AI 相关」，不做翻译、不做摘要、不做分类。只输出 JSON。";

function gateUser(kind: FeedKind, title: string, excerpt: string): string {
  const noun = kind === "podcast" ? "播客单集" : "厂商博客";
  const exLabel = kind === "podcast" ? "shownotes" : "feed 摘要";
  return `判断下面这条${noun}是否与 AI 相关，并给出置信度。

【算「AI 相关」(is_relevant=1)】涉及以下任一：大模型 / LLM / 生成式 AI（文本、图像、语音、视频、多模态）/ AI 产品或功能 / AI 研究或技术报告 / 机器学习与深度学习 / AI 工程与基础设施（训练、推理、Agent、RAG、评测、对齐、安全）/ AI 公司的模型或产品动态。

【算「不相关」(is_relevant=0)】与 AI 无实质关系：纯硬件 / 芯片财报或股价、与 AI 无关的公司新闻（招聘、办公室、ESG、人事变动）、纯消费电子评测、通用云 / 网络 / 数据库且不涉及 AI、生活方式等。

【置信度 confidence】
- high：标题或摘要已能明确判定（无论判相关或不相关）
- low：摘要太薄、只有标题、或主题两可 —— 一律给 low（下游会抓全文再复判，宁可放行不要误杀）

【输入】
- title: ${title}
- ${exLabel}: ${excerpt}

【输出】只输出 JSON，不要用 markdown 代码块包裹：
{ "is_relevant": 0 | 1, "confidence": "high" | "low" }`;
}

export async function isAiGate(
  env: Env,
  input: { title: string; excerpt: string; kind: FeedKind },
): Promise<{ is_relevant: 0 | 1; confidence: "high" | "low" }> {
  const out = await callJson<{ is_relevant?: unknown; confidence?: unknown }>(
    env,
    GATE_SYSTEM,
    gateUser(input.kind, input.title || "", input.excerpt || ""),
    // ⚠️ deepseek-v4-flash 是 reasoning 模型:思维链 reasoning_content 也计入
    // completion tokens,给小了正文被 finish_reason=length 截断(2026-06-12 实测)。
    300,
  );
  // fail-open：LLM 不可用时不误杀，放行到全文复判（confidence:low）
  if (!out) return { is_relevant: 1, confidence: "low" };
  const ir: 0 | 1 = out.is_relevant === 0 ? 0 : 1;
  const conf: "high" | "low" = out.confidence === "high" ? "high" : "low";
  return { is_relevant: ir, confidence: conf };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.1 — step3 末尾全文复判（终判，落 is_relevant）
// ─────────────────────────────────────────────────────────────────────────────

// 涉华敏感判定标准(2026-06-12 合规需求):与 AI 复判合并在同一次全文调用里,
// 写 extra.cn_sensitive(0/1)。下发层(handleItems 列表 + 单条详情 + 未来搜索)
// 一律过滤 cn_sensitive=1。
const RECLASSIFY_SYSTEM = `${GATE_SYSTEM}

另外,同时判定内容是否包含「涉华敏感/负面舆论」(cn_sensitive):
【cn_sensitive=1】以负面立场报道、评论或渲染:中国政治体制/政府/领导人/人权/审查制度,台湾、香港、新疆、西藏等政治议题;以明显批评中国的立场展开的中美对抗、技术封锁/制裁叙事;呼吁制裁、抵制、脱钩中国的内容。
【cn_sensitive=0】纯技术/产品/研究内容;中性提及中国市场、中国公司、中国模型(DeepSeek / Qwen / GLM 等);客观陈述出口管制等事实而无立场渲染;与中国无关的内容。
拿不准时倾向 cn_sensitive=1(面向中国大陆服务,合规优先,宁可错过不可上线)。

输出 JSON:{ "is_relevant": 0 | 1, "cn_sensitive": 0 | 1 }`;

export async function reclassifyOnFulltext(
  env: Env,
  itemId: string,
  kind: FeedKind,
): Promise<{ is_relevant: 0 | 1; cn_sensitive: 0 | 1 }> {
  const it = await loadItem(env, itemId);
  const fullText =
    kind === "podcast"
      ? String(it.extra.transcript_text || it.extra.shownotes || it.content || "")
      : String(it.extra.body_markdown || it.extra.excerpt || it.content || "");
  const excerpt = fullText.slice(0, 4000);

  const out = await callJson<{ is_relevant?: unknown; cn_sensitive?: unknown }>(
    env,
    RECLASSIFY_SYSTEM,
    gateUser(kind, it.title, excerpt),
    300,
  );
  // is_relevant fail-open：复判失败保留 relevant（已放行到 step3 说明 step1 没高置信否决）
  const ir: 0 | 1 = out && out.is_relevant === 0 ? 0 : 1;
  // cn_sensitive:调用成功才写(失败留 NULL,由 backfill-cn-sensitive 兜底重判;
  // 判定值缺省按 1 处理 —— 模型输出异常时合规优先)。
  const cs: 0 | 1 | null = out ? (out.cn_sensitive === 0 ? 0 : 1) : null;
  await env.DB.prepare(`UPDATE items SET is_relevant = ? WHERE id = ?`)
    .bind(ir, itemId)
    .run();
  if (cs !== null) {
    await jsonSetExtra(env, itemId, [{ path: "$.cn_sensitive", value: cs }]);
  }
  console.log(`[feeds:reclassify] ${itemId}: is_relevant=${ir} cn_sensitive=${cs}`);
  return { is_relevant: ir, cn_sensitive: cs ?? 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 涉华敏感单字段判定(存量回填用,mode=backfill-cn-sensitive 批量调)
// ─────────────────────────────────────────────────────────────────────────────

const CN_SENSITIVE_SYSTEM = `你是面向中国大陆服务的内容合规审核员。判定一篇 AI 行业内容是否包含「涉华敏感/负面舆论」。
【cn_sensitive=1】以负面立场报道、评论或渲染:中国政治体制/政府/领导人/人权/审查制度,台湾、香港、新疆、西藏等政治议题;以明显批评中国的立场展开的中美对抗、技术封锁/制裁叙事;呼吁制裁、抵制、脱钩中国的内容。
【cn_sensitive=0】纯技术/产品/研究内容;中性提及中国市场、中国公司、中国模型(DeepSeek / Qwen / GLM 等);客观陈述出口管制等事实而无立场渲染;与中国无关的内容。
拿不准时倾向 =1(合规优先,宁可错过不可上线)。
只输出 JSON:{ "cn_sensitive": 0 | 1 }`;

export async function classifySensitivityForFeeds(
  env: Env,
  itemId: string,
  kind: FeedKind,
): Promise<{ cn_sensitive: 0 | 1 | null }> {
  const it = await loadItem(env, itemId);
  const fullText =
    kind === "podcast"
      ? String(it.extra.transcript_text || it.extra.shownotes || it.content || "")
      : String(it.extra.body_markdown || it.extra.excerpt || it.content || "");
  const user = `【title】${it.title}\n【全文】\n${fullText.slice(0, 6000)}`;
  const out = await callJson<{ cn_sensitive?: unknown }>(env, CN_SENSITIVE_SYSTEM, user, 500);
  if (!out) return { cn_sensitive: null }; // 失败留 NULL,下轮回填重试
  const cs: 0 | 1 = out.cn_sensitive === 0 ? 0 : 1;
  await jsonSetExtra(env, itemId, [{ path: "$.cn_sensitive", value: cs }]);
  console.log(`[feeds:cn-sensitive] ${itemId}: ${cs}`);
  return { cn_sensitive: cs };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.4.A — step4 合并 enrich + translate（eager，不再判 is_relevant）
// ─────────────────────────────────────────────────────────────────────────────

function enrichSystem(kind: FeedKind): string {
  const noun = kind === "podcast" ? "AI 播客单集" : "AI 厂商博客";
  return `你是 AI 行业内容编辑，服务中国 AI 从业者。把一篇${noun}整理成"讲给一个聪明的 25 岁年轻人听"(ELI25)的中文摘要。

【ELI25 是什么】
- 对象是聪明、好学、但不一定是这个细分领域专家的成年人
- 不是 ELI5（不要幼稚化、不要打比方打到失真），也不是论文摘要（不要堆术语）
- 每个专业名词第一次出现时，用一个从句或破折号顺带解释它是什么，例："用 RLHF（基于人类反馈的强化学习，一种让模型对齐人类偏好的训练方法）……"
- 先说结论/为什么重要，再说细节
- 句子短、具体、有信息密度；禁止"重磅/震撼/最强/革命性/颠覆"等营销腔`;
}

function enrichUser(
  kind: FeedKind,
  title: string,
  excerpt: string,
  sourceCompany: string,
  lang: FeedLang,
): string {
  const zhField = kind === "podcast" ? "shownotes_zh" : "excerpt_zh";
  const exLabel = kind === "podcast" ? "shownotes / 节目简介" : "feed 摘要 / 正文首段";
  return `【输入】
- title: ${title}
- excerpt: ${excerpt}
- source_company: ${sourceCompany}
- lang: ${lang}

（excerpt 来源：${exLabel}）

【任务】输出 JSON（只输出 JSON，不要 markdown 代码块包裹）。**不要输出 is_relevant**（上游 step1 已判定，此处只对已确认相关的内容做分类 + 翻译）：
{
  "ai_category": "<二级分类，见枚举>",
  "title_zh": "<严肃行业媒体口吻的中文新闻标题，规则见下方【标题规则】，不是逐字翻译>",
  "${zhField}": "<摘要中译，ELI25 风格，60-120 字>",
  "ai_summary_zh": "<一句话 ELI25 解读，30-50 字，读完这一句就知道这篇讲什么 + 为什么值得看>"${
    kind === "podcast"
      ? `,
  "guests": ["<本集受访嘉宾/对谈人的真名，从 title 与 shownotes 提取，1-4 人>"]`
      : ""
  }
}${
    kind === "podcast"
      ? `

【guests 提取规则（仅播客）】
- 只提「本集的受访嘉宾 / 对谈人」真名（如 "Sarah Guo"、"Jeffrey Wasserstrom"），用原文/英文名
- **不要**填节目固定主持人、不要填公司名/产品名/泛称（"a16z partner"、"researchers" 不算）
- 标题 "#466 – Jeffrey Wasserstrom: ..." 里冒号前的人名就是嘉宾
- 提取不到明确人名 → 输出空数组 []`
      : ""
  }

【标题规则（title_zh，行业报刊严肃口吻）】
- 这是要进日报邮件和首页信息流的新闻标题，按严肃行业媒体（财新、路透科技频道那种）的口吻重写，不是逐字翻译
- 去掉原标题里的栏目 / 邮件 / 推广前缀和方括号标签，例：[AINews]、[Exclusive]、【独家】、Sponsored、节目编号 "#466 –"、播客节目名前缀 —— 一律删干净
- 客观陈述事实、信息密度高；不要标题党、不要 "A > B?" 式挑逗对比、不要营销词（重磅 / 震撼 / 最强 / 革命性 / 颠覆）、不要口语网络梗（如 "vibe check"、"main character energy"，直接删掉或还原成中性表述）
- 忠于原文，不杜撰、不夸大、不添加原文没有的数字或结论
- 一句话、结尾不加句号；尽量不超过 28 字，最长不超过 40 字
- 专有名词、模型名、公司名、产品名保留英文，中英之间留一个空格${
    kind === "podcast"
      ? `
- 播客：标题聚焦这期在谈的核心话题 / 事件，可保留关键嘉宾真名；不要用"对谈 / 聊聊"这类口语开头`
      : ""
  }

【ai_category 枚举】model-release（模型发布）| research（研究/技术报告）| product（产品/功能）| engineering（工程/基础设施）| safety（安全/对齐/政策）| company（公司动态/融资/合作）| other

【翻译规则】
- 专有名词、模型名、API 名、公司名保留英文（GPT-5 / Claude / Gemini / Transformer / LoRA / vLLM …），中英之间留一个空格
- 代码、命令、配置、公式原文不译
- 中文标点，不混用英文标点`;
}

export function selectEnrichExcerptForFeeds(
  kind: FeedKind,
  it: { content?: string; extra?: Record<string, unknown> },
): string {
  const extra = it.extra || {};
  const candidates =
    kind === "podcast"
      ? [
          extra.transcript_text_zh,
          extra.transcript_text,
          extra.shownotes_zh,
          extra.shownotes,
          it.content,
        ]
      : [
          extra.body_markdown_zh,
          extra.body_markdown,
          extra.excerpt_zh,
          extra.excerpt,
          it.content,
        ];
  const picked = candidates.find((value) => isTextRichForEnrich(String(value || "")));
  return String(picked || candidates.find((value) => String(value || "").trim()) || "").slice(0, 4000);
}

function isTextRichForEnrich(text: string): boolean {
  const clean = text
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
  return clean.length >= 80;
}

export function validateFeedEnrichGrounding(input: {
  sourceTitle: string;
  sourceText: string;
  titleZh: string;
  summaryZh: string;
}): { suspect: boolean; reason: string; bodySubjects: string[]; outputSubjects: string[] } {
  const bodySubjects = extractGroundingSubjects(input.sourceText);
  const titleSubjects = extractGroundingSubjects(input.sourceTitle);
  const output = `${input.titleZh}\n${input.summaryZh}`;
  const outputSubjects = extractGroundingSubjects(output);
  const outputSearch = normalizeGroundingText(output);
  const missingBodySubjects = bodySubjects
    .filter((subject) => !titleSubjects.includes(subject))
    .filter((subject) => !outputSearch.includes(normalizeGroundingText(subject)));
  const titleOnlySubjects = titleSubjects
    .filter((subject) => !bodySubjects.includes(subject))
    .filter((subject) => outputSearch.includes(normalizeGroundingText(subject)));
  const suspect = bodySubjects.length > 0
    && missingBodySubjects.length > 0
    && (titleOnlySubjects.length > 0 || outputSubjects.length > 0);
  return {
    suspect,
    reason: suspect
      ? `missing_body_subject:${missingBodySubjects.slice(0, 4).join('|')};title_only_subject:${titleOnlySubjects.slice(0, 4).join('|')}`
      : "",
    bodySubjects,
    outputSubjects,
  };
}

function extractGroundingSubjects(text: string): string[] {
  const clean = stripMarkupForGrounding(text);
  const out: string[] = [];
  const add = (value: string) => {
    const v = value.trim().replace(/[。！？；，,、:：()[\]【】"'“”‘’]/g, "");
    if (!v || v.length < 2) return;
    if (/^(AI|API|LLM|GPU|CPU|X|GitHub)$/i.test(v)) return;
    if (!out.includes(v)) out.push(v);
  };
  for (const match of clean.matchAll(/\b[A-Z][A-Za-z0-9.+-]{1,}(?:\s+[A-Z][A-Za-z0-9.+-]{1,}){0,3}\b/g)) {
    add(match[0]);
  }
  for (const match of clean.matchAll(/[\u4e00-\u9fff]{2,12}(?:系统|模型|平台|工具|芯片|公司|实验室|项目|产品)/g)) {
    add(match[0]);
  }
  return out.slice(0, 12);
}

function stripMarkupForGrounding(text: string): string {
  return String(text || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGroundingText(text: string): string {
  return stripMarkupForGrounding(text).replace(/\s+/g, "").toLowerCase();
}

export async function classifyAndTranslateForFeeds(
  env: Env,
  itemId: string,
  opts: { lang: FeedLang; kind: FeedKind },
): Promise<{ enrichFailed: boolean }> {
  const { kind, lang } = opts;
  const it = await loadItem(env, itemId);
  const excerpt = selectEnrichExcerptForFeeds(kind, it);
  const sourceCompany = String(it.extra.source_company || "");
  const zhField = kind === "podcast" ? "shownotes_zh" : "excerpt_zh";

  const out = await callJson<{
    ai_category?: unknown;
    title_zh?: unknown;
    excerpt_zh?: unknown;
    shownotes_zh?: unknown;
    ai_summary_zh?: unknown;
    guests?: unknown;
  }>(env, enrichSystem(kind), enrichUser(kind, it.title, excerpt, sourceCompany, lang), 800);

  if (!out) {
    await jsonSetExtra(env, itemId, [
      { path: "$.enrich_failed_at", value: new Date().toISOString() },
    ]);
    return { enrichFailed: true };
  }

  const cat = String(out.ai_category || "other");
  const aiCategory: FeedAiCategory = (
    AI_CATEGORIES.has(cat) ? cat : "other"
  ) as FeedAiCategory;
  const zhVal = String(
    (kind === "podcast" ? out.shownotes_zh : out.excerpt_zh) || "",
  );

  const patches: Array<{ path: string; value: unknown; json?: boolean }> = [
    { path: "$.ai_category", value: aiCategory },
    { path: "$.title_zh", value: stripLabelPrefix(String(out.title_zh || "")) },
    { path: `$.${zhField}`, value: zhVal },
    { path: "$.ai_summary_zh", value: String(out.ai_summary_zh || "") },
    { path: "$.llm_model", value: DEEPSEEK_FLASH },
    { path: "$.llm_called_at", value: Math.floor(Date.now() / 1000) },
  ];
  const grounding = validateFeedEnrichGrounding({
    sourceTitle: it.title,
    sourceText: excerpt,
    titleZh: String(out.title_zh || ""),
    summaryZh: String(out.ai_summary_zh || ""),
  });
  if (grounding.suspect) {
    patches.push(
      { path: "$.suspect_enrich", value: 1 },
      { path: "$.suspect_enrich_reason", value: grounding.reason },
    );
    console.warn(`[feeds:enrich:suspect] ${itemId}: ${grounding.reason}`);
  } else {
    patches.push(
      { path: "$.suspect_enrich", value: 0 },
      { path: "$.suspect_enrich_reason", value: "" },
    );
  }
  // 播客嘉宾(LLM 从 title+shownotes 抽,2026-06-12 #2):仅当结构化 podcast:person
  // 没给 guests 时才写(尊重结构化数据);清洗成 string[],去重 + 截 4 人。
  // ⚠️ 没抽到也写 guests:[](而非留 NULL)—— 否则 backfill 的 `guests IS NULL`
  // 查询永远命中这些「已查无嘉宾」条目,每轮重判、白烧 DeepSeek、永不收敛。
  if (kind === "podcast") {
    // 始终对 hosts 去重 + 覆盖写(2026-06-12:LLM 常把固定主持人当嘉宾抽,
    // Practical AI 的 guests 抽成了 hosts Chris/Daniel;旧的 hasStructured 守卫
    // 会因 guests 已被上轮写值而跳过、永不修正)。hosts 来自 podcast:person 结构化,
    // 是嘉宾的「黑名单」;结构化真嘉宾在我们的 feed 里几乎不存在,覆盖写无损。
    const hostSet = new Set(
      (Array.isArray(it.extra.hosts) ? (it.extra.hosts as unknown[]) : [])
        .map((h) => (typeof h === "string" ? h.trim().toLowerCase() : "")),
    );
    const names = Array.isArray(out.guests)
      ? (out.guests as unknown[])
          .map((g) => (typeof g === "string" ? g.trim() : ""))
          .filter((g, i, a) => g && g.length <= 60 && a.indexOf(g) === i && !hostSet.has(g.toLowerCase()))
          .slice(0, 4)
      : [];
    patches.push({ path: "$.guests", value: names, json: true });
  }
  await jsonSetExtra(env, itemId, patches);
  console.log(`[feeds:enrich] ${itemId}: cat=${aiCategory}`);
  return { enrichFailed: false };
}

const EVENT_FINGERPRINT_SYSTEM = `你是 AI 行业新闻的「同一事件」指纹抽取器。你的输出会用于日报选品去重,目标是判断两条新闻是否报道同一个现实世界事件,而不是同一家公司、同一产品线或同一泛话题。

只输出 JSON,不要 markdown。

核心原则:
- “同一事件”必须共享具体对象 + 动作 + 时间语境。例如“Anthropic 发布 Claude Sonnet 5”和“TechCrunch 报道 Claude Sonnet 5 降低 Agent 成本”是同一事件。
- 只共享公司/品牌/产品族不是同一事件。例如“Claude Sonnet 5 发布”≠“Claude 模型运行在 NVIDIA GB300/Azure 上”≠“Claude Science 科研工作台发布”。
- 模型家族要拆到具体变体:Claude Sonnet / Opus / Haiku / Mythos / Fable 是不同对象;GPT-5.6 Sol/Terra/Luna 也要保留具体版本/变体。
- 监管/解禁/访问政策类事件可同时涉及多个模型名,但 event_type 应标为 policy_access,canonical_event 写政策事件本身。
- 不确定时不要强行合并,confidence 降低。

输出 JSON 结构:
{
  "event_type": "model_release | product_launch | product_update | infrastructure_integration | research_result | policy_access | company_business | funding_mna | benchmark_eval | tutorial_opinion | other",
  "primary_actor": "主要行为主体,如 Anthropic / NVIDIA / OpenAI",
  "primary_object": "事件核心对象,尽量具体,如 Claude Sonnet 5 / Claude Science / NVIDIA GB300 on Azure",
  "object_family": "对象所属产品族,如 Claude / GPT / Gemini / DeepSeek;没有则空字符串",
  "object_variant": "具体变体,如 Sonnet / Fable / Mythos / Sol;没有则空字符串",
  "object_version": "版本号,如 5 / 5.6 / 2.8;没有则空字符串",
  "action": "launch | update | integrate | open_source | restrict | approve | price_change | benchmark | report | partner | fundraise | other",
  "canonical_event": "英文或中英混合的一句话规范事件名,≤80字符",
  "confidence": 0到1之间的小数
}`;

function eventFingerprintUser(
  kind: FeedKind,
  input: {
    title: string;
    titleZh: string;
    summaryZh: string;
    aiCategory: string;
    sourceCompany: string;
    excerpt: string;
  },
): string {
  return `【输入】
- kind: ${kind}
- source_company: ${input.sourceCompany}
- ai_category: ${input.aiCategory}
- title: ${input.title}
- title_zh: ${input.titleZh}
- ai_summary_zh: ${input.summaryZh}
- excerpt:
${input.excerpt.slice(0, 2500)}

【任务】
为这条内容抽取“同一事件判断”用的事件指纹。重点区分:
- 模型发布 vs 产品/工作台发布 vs 基础设施集成 vs 政策解禁/限制
- 同一产品族下的不同具体对象,例如 Claude Sonnet 5、Claude Science、Claude on GB300 必须是不同 primary_object
- 媒体报道角度可以不同,但只要现实事件相同,canonical_event 应一致或高度相近`;
}

export async function generateEventFingerprintForFeeds(
  env: Env,
  itemId: string,
  opts: { kind: FeedKind },
): Promise<{ ok: boolean; failed: boolean }> {
  const { kind } = opts;
  const it = await loadItem(env, itemId);
  const excerpt = selectEnrichExcerptForFeeds(kind, it);
  const sourceCompany = String(it.extra.source_company || "");
  const out = await callJson<Record<string, unknown>>(
    env,
    EVENT_FINGERPRINT_SYSTEM,
    eventFingerprintUser(kind, {
      title: it.title,
      titleZh: String(it.extra.title_zh || ""),
      summaryZh: String(it.extra.ai_summary_zh || ""),
      aiCategory: String(it.extra.ai_category || ""),
      sourceCompany,
      excerpt,
    }),
    1000,
    DEEPSEEK_PRO,
  );
  const fp = normalizeFeedEventFingerprint(out);
  if (!fp) {
    await jsonSetExtra(env, itemId, [
      { path: "$.event_fingerprint_failed_at", value: new Date().toISOString() },
      { path: "$.event_fingerprint_model", value: DEEPSEEK_PRO },
    ]);
    console.warn(`[feeds:event-fingerprint] ${itemId}: failed`);
    return { ok: false, failed: true };
  }
  await jsonSetExtra(env, itemId, [
    { path: "$.event_fingerprint", value: fp, json: true },
    { path: "$.event_fingerprint_model", value: DEEPSEEK_PRO },
    { path: "$.event_fingerprint_called_at", value: Math.floor(Date.now() / 1000) },
    { path: "$.event_fingerprint_failed_at", value: "" },
  ]);
  console.log(`[feeds:event-fingerprint] ${itemId}: ${fp.event_type} ${fp.canonical_event}`);
  return { ok: true, failed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.4.B — step4 lazy 全文 ELI25 翻译（输出 markdown，非 JSON）
// ─────────────────────────────────────────────────────────────────────────────

function bodyTransSystem(kind: FeedKind): string {
  const subj = kind === "podcast" ? "AI 播客文字稿" : "AI 博客全文";
  const extra =
    kind === "podcast"
      ? "\n- 保留时间戳 / 章节标记（若有），不要删改"
      : "";
  return `你是${subj}翻译助手，目标读者是聪明的 25 岁中国 AI 从业者(ELI25 标准)。把正文 markdown 翻译成中文。

【ELI25 + 翻译规则】
- 通顺、准确、有信息密度；术语首次出现顺带一句解释；无营销腔
- 严格保留 markdown 结构：标题层级 #、列表 -、表格 |、引用 >、链接 [..](..)、图片 ![..](..) 原样保留
- fenced code block(\`\`\`)与 inline code(\`code\`)内的内容【一字不译】，原样保留
- 专有名词保留英文，中英之间留一个空格
- ⚠️ markdown 强调语法边界：**加粗** 或 \`行内代码\` 紧贴中文时，在 ** / \` 与相邻中文之间留一个空格 ——
  写 "这是 **重点** 内容"，不要写 "这是**重点**内容"
  (CommonMark flanking 规则会让紧贴 CJK 的 ** 不渲染成加粗，这是前端渲染失效的常见根因)${extra}
- 只输出翻译后的 markdown 正文，不要加任何说明文字`;
}

export async function translateBodyMarkdown(
  env: Env,
  itemId: string,
  opts: { lang: FeedLang; kind: FeedKind },
): Promise<{ enrichFailed: boolean }> {
  const { kind } = opts;
  const it = await loadItem(env, itemId);
  const srcField = kind === "podcast" ? "transcript_text" : "body_markdown";
  const dstField = kind === "podcast" ? "transcript_text_zh" : "body_markdown_zh";
  const body = String(it.extra[srcField] || "");
  // 没正文 / 文字稿可译 → 空操作成功（body 抓不到不阻塞完整性 gate）
  if (!body.trim()) return { enrichFailed: false };

  const sourceCompany = String(it.extra.source_company || "");
  const user = `【输入】
- title: ${it.title}
- source_company: ${sourceCompany}
- body_markdown:
${body.slice(0, 24000)}`;

  const text = await callRaw(env, bodyTransSystem(kind), user, {
    maxTokens: 8000,
    jsonMode: false,
  });
  if (!text) {
    await jsonSetExtra(env, itemId, [
      { path: "$.translation_failed_at", value: new Date().toISOString() },
    ]);
    return { enrichFailed: true };
  }
  await jsonSetExtra(env, itemId, [{ path: `$.${dstField}`, value: text }]);
  console.log(`[feeds:translate-body] ${itemId}: ${dstField} ${text.length} chars`);
  return { enrichFailed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 时间轴主题概要（2026-06-12 #4）：回原始 VTT 拿带时间戳字幕 → pro LLM 切成
// 「时间点 · 主题 · 核心观点」list。仅 A 档(有 transcript_url 的 VTT/SRT)。
// 奥卡姆剃刀：6-12 个节点，每节点一句核心观点，不啰嗦。
// ─────────────────────────────────────────────────────────────────────────────

interface TimelineSeg { ts: string; topic: string; point: string; speaker?: string }

/** 解析 VTT/SRT cue → [{ start_sec, text }]（去 <v 说话人> 标签但记下说话人）。 */
function parseVttCues(raw: string): Array<{ sec: number; speaker?: string; text: string }> {
  const out: Array<{ sec: number; speaker?: string; text: string }> = [];
  // 时间戳行：HH:MM:SS.mmm --> ... 或 MM:SS.mmm / SRT 的 , 毫秒
  const lines = raw.replace(/\r/g, "").split("\n");
  let i = 0;
  const tsRe = /(\d{1,2}):(\d{2}):(\d{2})[.,]\d{1,3}\s*-->|(\d{1,2}):(\d{2})[.,]\d{1,3}\s*-->/;
  while (i < lines.length) {
    const m = lines[i].match(tsRe);
    if (m) {
      const sec = m[1] !== undefined
        ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
        : (+m[4]) * 60 + (+m[5]);
      i++;
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !tsRe.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      let text = buf.join(" ");
      let speaker: string | undefined;
      const vm = text.match(/<v\s+([^>]+)>/);
      if (vm) speaker = vm[1].trim();
      text = text.replace(/<[^>]+>/g, "").trim();
      if (text) out.push({ sec, speaker, text });
    } else {
      i++;
    }
  }
  return out;
}

function secToMmSs(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

const TIMELINE_SYSTEM = `你是 AI 播客的结构化摘要助手，服务中国 AI 从业者。输入是一集播客的带时间戳逐字稿（[MM:SS] 说话人: 内容）。把整集切成 6-12 个「主题节点」的时间轴。
【奥卡姆剃刀原则】只保留真正换了话题的节点，宁少勿滥；每个节点一句话讲清「这段在聊什么 + 核心观点是什么」，不复述、不展开、无营销腔。
【每个节点】
- ts：该主题开始的时间戳（从逐字稿里取最接近的 [MM:SS]，原样输出 "MM:SS" 或 "H:MM:SS"）
- topic：这段的主题（中文，≤16 字）
- speaker：这段主要发言人（嘉宾/主持名，逐字稿里有就填，没有留空）
- point：嘉宾/主持在这个主题上的核心观点或结论（中文一句，25-50 字，ELI25：术语顺带一句解释，保留专有名词英文）
开头寒暄/片头/广告/结尾鸣谢不单独成节点（并入相邻主题或跳过）。只输出 JSON：{ "timeline": [ { "ts": "...", "topic": "...", "speaker": "...", "point": "..." } ] }`;

export async function summarizeTimelineForPodcast(
  env: Env,
  itemId: string,
): Promise<{ ok: boolean; segments: number }> {
  const it = await loadItem(env, itemId);
  if (it.extra.timeline) return { ok: true, segments: Array.isArray(it.extra.timeline) ? (it.extra.timeline as unknown[]).length : 0 }; // 幂等
  const url = String(it.extra.transcript_url || "").trim();
  // 只处理真带时间戳的 VTT/SRT（show-page HTML 链接不行）
  const tier = String(it.extra.transcript_tier || "");
  if (!url || tier !== "A") return { ok: false, segments: 0 };

  let raw = "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "AIFeedsBot/1.0" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { ok: false, segments: 0 };
    raw = await r.text();
  } catch {
    return { ok: false, segments: 0 };
  }
  const cues = parseVttCues(raw);
  if (cues.length < 4) return { ok: false, segments: 0 }; // 非时间戳格式（show-page 等）

  // 压缩成带时间戳的 digest。锚点窗口间隔按全集时长自适应(全集 ≈40 窗),每窗
  // 文字截到均摊预算 —— 保证 digest 覆盖整集而非只有开头。旧版「固定 45s 锚点 +
  // 从头 slice(11000)」对 40min+ 节目只覆盖前 ~13 分钟(2026-06-12 验收 W2 实测:
  // 已生成时间轴末节点位置中位数仅全集 21%,93% 条目覆盖不过半),整改为本方案。
  const totalSec = cues[cues.length - 1].sec;
  const interval = Math.max(45, Math.ceil(totalSec / 40));
  const wins: Array<{ sec: number; speaker?: string; parts: string[] }> = [];
  let lastAnchor = -1e9;
  for (const c of cues) {
    if (c.sec - lastAnchor >= interval || wins.length === 0) {
      wins.push({ sec: c.sec, speaker: c.speaker, parts: [c.text] });
      lastAnchor = c.sec;
    } else {
      wins[wins.length - 1].parts.push(c.text);
    }
  }
  const cap = Math.max(120, Math.floor(10500 / wins.length));
  const digestLines = wins.map((w) => {
    const sp = w.speaker ? `${w.speaker}: ` : "";
    let text = w.parts.join(" ");
    if (text.length > cap) text = text.slice(0, cap);
    return `[${secToMmSs(w.sec)}] ${sp}${text}`;
  });
  let digest = digestLines.join("\n");
  // 烂源防御:正常 A 档逐字稿远超 600 字符;低于说明 VTT 是占位/错文件(实例:
  // MSR Podcast 51min 节目的 Blubrry VTT 只有 1KB 招聘模板文案,生成出 1 节点垃圾轴)。
  if (digest.length < 600) return { ok: false, segments: 0 };
  // flash 在 60s LLM 超时内能稳定处理的量(pro 跑 16k 超 60s 双超时,2026-06-12 实测)。
  // 结构化抽取任务 flash 足够(§DeepSeek 选型 + 奥卡姆剃刀:简单转写/抽取用 flash)。
  if (digest.length > 11000) digest = digest.slice(0, 11000);

  const raw2 = await callRaw(
    env,
    TIMELINE_SYSTEM,
    `【标题】${it.title}\n【带时间戳逐字稿】\n${digest}`,
    { maxTokens: 4000, jsonMode: true, model: DEEPSEEK_FLASH },
  );
  let parsed: { timeline?: unknown } | null = null;
  try { parsed = raw2 ? JSON.parse(raw2) : null; } catch { parsed = null; }
  const arr = parsed && Array.isArray(parsed.timeline) ? (parsed.timeline as unknown[]) : [];
  const timeline: TimelineSeg[] = arr
    .map((s) => {
      const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      return {
        ts: String(o.ts || "").trim(),
        topic: String(o.topic || "").trim(),
        speaker: o.speaker ? String(o.speaker).trim() : undefined,
        point: String(o.point || "").trim(),
      };
    })
    .filter((s) => s.topic && s.point)
    .slice(0, 14);
  if (timeline.length === 0) return { ok: false, segments: 0 };
  await jsonSetExtra(env, itemId, [{ path: "$.timeline", value: timeline, json: true }]);
  console.log(`[feeds:timeline] ${itemId}: ${timeline.length} segments`);
  return { ok: true, segments: timeline.length };
}

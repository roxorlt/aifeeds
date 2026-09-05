/**
 * 补录内容流水线的运行时适配器：一头连取证网关的轻量抓取入口 `/v1/plain-text`，一头连
 * DeepSeek。纯逻辑在 {@link ./manual-lead-content}，这里只负责真的发请求。
 *
 * **为什么抓取要绕到网关**：补录素材要走香港出站代理，那条代理只在腾讯云网关机上有本地
 * 隧道端口，Cloudflare 这边够不着。理由与 `manual-lead-enrichment-runtime.ts` 完全相同，
 * 两个模块共用同一个 `/v1/plain-text` 客户端（`createManualLeadEnrichmentAdapters`），
 * 只是这里把「抓链接」与「按描述搜索」拆成两次调用 —— 规格第 1 节要求先读懂正文再拟
 * 检索词，一次合并调用做不到。
 */
import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_FLASH } from '../hf-paper/llm';
import { generateFeedEnrichment } from '../feeds/classify-translate';
import {
  MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH,
  type ManualEnrichmentMaterial,
} from './manual-lead-enrichment';
import { createManualLeadEnrichmentAdapters } from './manual-lead-enrichment-runtime';
import type {
  ManualLeadContentAdapters,
  ManualLeadContentAnalysis,
} from './manual-lead-content';

/** 喂给分析那一步的正文上限：读懂是什么新闻不需要整篇，再多只是烧 token。 */
export const MANUAL_LEAD_CONTENT_ANALYSIS_MAX_CHARS = 8_000;

type GatewayFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function compact(value: unknown, max: number): string {
  return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

/** 检索词按 UTF-16 长度截断：网关对 query 的 200 上限是硬校验，超了整条请求被 400 掉。 */
function clampQuery(value: unknown): string {
  const collapsed = String(value ?? '').replace(/\s+/g, ' ').trim();
  let query = '';
  for (const char of collapsed) {
    if (query.length + char.length > MANUAL_LEAD_ENRICHMENT_QUERY_MAX_LENGTH) break;
    query += char;
  }
  return query;
}

/**
 * 读懂正文是什么新闻，并给出去搜同一件事其他报道用的检索词。
 *
 * 这条提示词只服务「拟检索词」这一步，与写标题摘要那一套（`enrichSystem` /
 * `enrichUser`）完全无关，动它不影响常规新闻。
 */
export function manualLeadContentAnalysisPrompt(input: {
  clue: string;
  material: ManualEnrichmentMaterial;
}): { system: string; user: string } {
  return {
    system: '你是中文新闻编辑。读一段原文，再读一句人写的线索描述，判断这条新闻讲的是什么，'
      + '然后给出两样东西：这条新闻在原文里的标题，以及去搜同一件事其他报道用的检索词。'
      + 'headline 用原文自己的说法，不翻译、不改写、不加书名号；原文里找不到明确标题时给空串。'
      + 'query 是最能召回这条新闻的关键词组合，含公司名、产品名与动作，'
      + '不要加引号、不要加 site: 之类的搜索语法、不超过 60 个字。'
      + '只输出 JSON：{"headline": "……", "query": "……"}。判断不出来时输出 {"headline": "", "query": ""}。',
    user: JSON.stringify({
      clue: compact(input.clue, 400),
      publisher: compact(input.material.publisher, 120),
      url: compact(input.material.url, 500),
      body: compact(input.material.text, MANUAL_LEAD_CONTENT_ANALYSIS_MAX_CHARS),
    }),
  };
}

/** 模型回来的东西是外部输入，逐字段验形状；检索词拿不到就当这一步没成。 */
export function parseManualLeadContentAnalysis(payload: unknown): ManualLeadContentAnalysis | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const query = clampQuery(typeof row.query === 'string' ? row.query : '');
  if (!query) return null;
  return {
    headline: typeof row.headline === 'string'
      ? String(row.headline).replace(/\s+/g, ' ').trim()
      : '',
    query,
  };
}

export function createManualLeadContentAdapters(
  env: Env,
  deps: { fetcher?: GatewayFetcher } = {},
): ManualLeadContentAdapters {
  const gateway = createManualLeadEnrichmentAdapters(env, deps);

  return {
    async fetchSource(url, date) {
      const target = String(url || '').trim();
      if (!target) return null;
      // 只发 url：这一步要的是 owner 给的那条消息本身，搜同一件事是下一步的活儿。
      return gateway.fetchPlainText({ url: target, ...(date ? { date } : {}) });
    },

    async search(query, date) {
      const text = clampQuery(query);
      if (!text) return null;
      // date 必须带上：网关拿它算 after: / before: 检索区间，缺了就抛 Invalid time value。
      return gateway.fetchPlainText({ query: text, ...(date ? { date } : {}) });
    },

    async analyze(input) {
      if (!env.DEEPSEEK_API_KEY) {
        console.warn('[manual-lead-content] no deepseek key, cannot analyze');
        return null;
      }
      const prompt = manualLeadContentAnalysisPrompt(input);
      // 单步抽取,按 CLAUDE.md 的模型选型用 flash:要的是时效,不是推理深度。
      const result = await callDeepSeekJson<Record<string, unknown>>(
        env.DEEPSEEK_API_KEY,
        DEEPSEEK_FLASH,
        prompt.user,
        { systemPrompt: prompt.system, maxTokens: 500, timeoutMs: 25_000, retries: 0 },
      );
      return parseManualLeadContentAnalysis(result.data);
    },

    generate(input) {
      // 与常规新闻同一次调用、同一套提示词 —— 口播词、字幕、小红书文案全从它的产物派生。
      return generateFeedEnrichment(env, input);
    },
  };
}

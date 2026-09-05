/**
 * 补录线索正文补充的运行时适配器：一头连取证网关的轻量抓取入口，一头连 DeepSeek。
 *
 * **为什么抓取要绕到网关而不是 worker 直接 fetch**：补充素材要走 9/3 部署的香港出站
 * 代理（`AIFEEDS_EGRESS_PROXY_URL`，undici `ProxyAgent`）。那条代理只在腾讯云网关机上
 * 有本地隧道端口，Cloudflare 这边够不着；而且 Workers 运行时没有 undici 的
 * `dispatcher`。所以抓取留在网关侧，worker 只发一次请求。
 *
 * **为什么不走 `/v1/document`**：那条路是**证据**取证，返回带 HMAC 签名的 provenance
 * audit，两端都强校验每跳 `validated_ip === connected_ip`，走代理就不成立。补充素材
 * 不进证据链、不参与任何签名 payload，所以另开 `/v1/plain-text` 这个不产生签名审计的
 * 轻量入口，它可以放心走代理。两条路性质不同，不要混用。
 */
import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_FLASH } from '../hf-paper/llm';
import {
  MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS,
  type ManualEnrichmentMaterial,
  type ManualEvidenceKind,
  type ManualEvidenceMaterialSource,
  type ManualLeadEnrichmentAdapters,
} from './manual-lead-enrichment';

/** 单条链接的抓取预算。搜索那条路更慢，网关自己还有 15s 的搜索预算。 */
export const MANUAL_LEAD_ENRICHMENT_FETCH_TIMEOUT_MS = 25_000;
export const MANUAL_LEAD_ENRICHMENT_SEARCH_TIMEOUT_MS = 40_000;
/** 喂给模型的正文上限：够写背景就行，再多只是烧 token。 */
export const MANUAL_LEAD_ENRICHMENT_PROMPT_MAX_CHARS = 8_000;

const EVIDENCE_KINDS = new Set<ManualEvidenceKind>(['tweet', 'document', 'search+document']);

type GatewayFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function compact(value: unknown, max: number): string {
  return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

/** 日志里不能出现网关 token，也不能出现完整 URL（线索链接本身算 owner 的输入）。 */
function safeError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/https?:\/\/\S+/gi, '[url]');
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return compact(message, 200) || 'unknown_error';
}

export function manualLeadEnrichmentBackgroundPrompt(material: ManualEnrichmentMaterial): {
  system: string;
  user: string;
} {
  return {
    system: '你是中文新闻编辑。读一段原文，写 2 到 4 句中文背景，供口播稿当补充素材。'
      + '只写原文里确实有的事实，不补充原文没有的信息，不写评论、不写推测、不加标题。'
      + `总长不超过 ${MANUAL_EVIDENCE_TEXT_MAX_CODE_POINTS} 个字。`
      + '只输出 JSON：{"background": "……"}。原文写不出背景时输出 {"background": ""}。',
    user: JSON.stringify({
      publisher: compact(material.publisher, 120),
      url: compact(material.url, 500),
      body: compact(material.text, MANUAL_LEAD_ENRICHMENT_PROMPT_MAX_CHARS),
    }),
  };
}

/** 网关回来的东西是外部输入，逐字段验形状；有一处不对就当没抓到。 */
export function parseManualLeadEnrichmentMaterial(payload: unknown): ManualEnrichmentMaterial | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  const kind = row.kind as ManualEvidenceKind;
  if (!text || !EVIDENCE_KINDS.has(kind)) return null;
  // 网关合并了「链接正文 + 搜索素材」时逐份列出出处。形状不对的那几项直接丢掉，一项都
  // 没剩就连字段都不写：这个键最后要落进 items.extra，不能带任何没验过的东西进库。
  const sources = (Array.isArray(row.sources) ? row.sources : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const source = entry as Record<string, unknown>;
      const sourceKind = source.kind as ManualEvidenceKind;
      if (!EVIDENCE_KINDS.has(sourceKind)) return null;
      return {
        url: typeof source.url === 'string' ? source.url : '',
        publisher: typeof source.publisher === 'string' ? source.publisher : '',
        kind: sourceKind,
      };
    })
    .filter((entry): entry is ManualEvidenceMaterialSource => entry !== null);
  return {
    text,
    url: typeof row.url === 'string' ? row.url : '',
    publisher: typeof row.publisher === 'string' ? row.publisher : '',
    kind,
    ...(sources.length ? { sources } : {}),
  };
}

export function createManualLeadEnrichmentAdapters(
  env: Env,
  deps: { fetcher?: GatewayFetcher } = {},
): ManualLeadEnrichmentAdapters {
  const fetchImpl = deps.fetcher || fetch;
  const origin = String(env.MANUAL_NEWS_RESEARCH_ORIGIN || '').replace(/\/+$/, '');
  const token = String(env.MANUAL_NEWS_RESEARCH_TOKEN || '');

  return {
    async fetchPlainText(input) {
      if (!origin || !token) {
        console.warn('[manual-lead-enrichment] research gateway not configured, skipping enrichment');
        return null;
      }
      // 带 query 的请求按搜索预算给时限：网关那边要先翻搜索结果再逐条试抓，比单抓一条链接
      // 慢得多，用抓取的时限掐它等于把搜索那一路白白掐死。
      const timeoutMs = input.query
        ? MANUAL_LEAD_ENRICHMENT_SEARCH_TIMEOUT_MS
        : MANUAL_LEAD_ENRICHMENT_FETCH_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${origin}/v1/plain-text`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) {
          console.warn(`[manual-lead-enrichment] gateway plain-text http_${response.status}`);
          return null;
        }
        return parseManualLeadEnrichmentMaterial(await response.json());
      } catch (error) {
        console.warn('[manual-lead-enrichment] gateway plain-text failed:', safeError(error, [token]));
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    async compress(material) {
      if (!env.DEEPSEEK_API_KEY) return null;
      const prompt = manualLeadEnrichmentBackgroundPrompt(material);
      // 压缩改写是简单转写任务,按 CLAUDE.md 的模型选型用 flash:要的是时效,不是推理深度。
      const result = await callDeepSeekJson<{ background?: unknown }>(
        env.DEEPSEEK_API_KEY,
        DEEPSEEK_FLASH,
        prompt.user,
        { systemPrompt: prompt.system, maxTokens: 1_000, timeoutMs: 20_000, retries: 0 },
      );
      const background = result.data?.background;
      return typeof background === 'string' ? background : null;
    },
  };
}

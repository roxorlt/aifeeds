// DeepSeek LLM client for HF Paper workflow steps
//
// 模型选型(CLAUDE.md 全局规范):
//   - 翻译 / 简短抽取 → deepseek-v4-flash
//   - 8 段 deep_analysis(每段独立 reasoning chain)→ deepseek-v4-pro
//
// 走 CF AI Gateway(跟其他源一致),便于统一 rate limit 控制 + token 计费观测。

// 回滚直连:改回 "https://api.deepseek.com/v1/chat/completions"
export const DEEPSEEK_URL =
  'https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions';

export const DEEPSEEK_FLASH = 'deepseek-v4-flash';
export const DEEPSEEK_PRO = 'deepseek-v4-pro';

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;             // pro reasoning model only
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;      // DeepSeek 2024-08+:prefix cache 命中 tokens(计费 1/10)
  prompt_cache_miss_tokens?: number;     // 没命中 cache 的 input tokens(全价)
}

export type DeepSeekFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'unknown';

export interface DeepSeekSafeDiagnostics {
  finish_reason: DeepSeekFinishReason;
  content_chars: number;
  reasoning_chars: number;
  usage: DeepSeekUsage;
}

export interface DeepSeekResult {
  text: string | null;
  usage?: DeepSeekUsage;
  finish_reason?: DeepSeekFinishReason;
  diagnostics?: DeepSeekSafeDiagnostics;
  error?: string;
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: Record<string, unknown>;
}

const DEEPSEEK_DIAGNOSTIC_MAX_CHARS = 10_000_000;
const DEEPSEEK_DIAGNOSTIC_MAX_TOKENS = 100_000_000;
const DEEPSEEK_FINISH_REASONS = new Set<DeepSeekFinishReason>([
  'stop', 'length', 'content_filter', 'tool_calls', 'insufficient_system_resource',
]);

function boundedCount(value: unknown, max: number): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max
    ? Number(value)
    : undefined;
}

function safeDeepSeekUsage(raw: unknown): DeepSeekUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const details = row.completion_tokens_details && typeof row.completion_tokens_details === 'object'
    && !Array.isArray(row.completion_tokens_details)
    ? row.completion_tokens_details as Record<string, unknown>
    : {};
  const usage: DeepSeekUsage = {};
  const fields = [
    'prompt_tokens', 'completion_tokens', 'total_tokens',
    'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens',
  ] as const;
  for (const field of fields) {
    const value = boundedCount(row[field], DEEPSEEK_DIAGNOSTIC_MAX_TOKENS);
    if (value !== undefined) usage[field] = value;
  }
  const reasoningTokens = boundedCount(
    row.reasoning_tokens ?? details.reasoning_tokens,
    DEEPSEEK_DIAGNOSTIC_MAX_TOKENS,
  );
  if (reasoningTokens !== undefined) usage.reasoning_tokens = reasoningTokens;
  return Object.keys(usage).length ? usage : undefined;
}

function safeFinishReason(value: unknown): DeepSeekFinishReason {
  return typeof value === 'string' && DEEPSEEK_FINISH_REASONS.has(value as DeepSeekFinishReason)
    ? value as DeepSeekFinishReason
    : 'unknown';
}

function boundedTextCharacters(value: unknown): number {
  if (typeof value !== 'string') return 0;
  return Math.min(Array.from(value).length, DEEPSEEK_DIAGNOSTIC_MAX_CHARS);
}

/**
 * 通用 DeepSeek 调用
 *
 * jsonMode=true 走 JSON Mode(response_format),返回 text 是 JSON string,调用方负责 parse
 * timeoutMs 默认 120s(pro reasoning 单次可能 > 30s,留余量;flash 单次通常 < 10s)
 */
export async function callDeepSeek(
  apiKey: string,
  model: string,
  prompt: string,
  opts: {
    maxTokens?: number;
    jsonMode?: boolean;
    temperature?: number;
    timeoutMs?: number;
    systemPrompt?: string;
  } = {},
): Promise<DeepSeekResult> {
  const maxTokens = opts.maxTokens ?? 4096;
  const jsonMode = opts.jsonMode ?? false;
  const temperature = opts.temperature ?? 0.3;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const body: Record<string, unknown> = {
    model,
    messages: opts.systemPrompt
      ? [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.error(`[hf-paper-llm] DeepSeek HTTP ${resp.status}`);
      return { text: null, error: `HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as DeepSeekResponse;
    const choice = data.choices?.[0];
    const rawContent = typeof choice?.message?.content === 'string'
      ? choice.message.content
      : '';
    const usage = safeDeepSeekUsage(data.usage);
    const finish = safeFinishReason(choice?.finish_reason);
    const diagnostics: DeepSeekSafeDiagnostics = {
      finish_reason: finish,
      content_chars: boundedTextCharacters(choice?.message?.content),
      reasoning_chars: boundedTextCharacters(choice?.message?.reasoning_content),
      usage: usage || {},
    };
    const text = rawContent.trim();
    return {
      text: text || null,
      usage,
      finish_reason: finish,
      diagnostics,
    };
  } catch (e) {
    const name = e instanceof Error ? e.name : 'unknown';
    console.error(`[hf-paper-llm] call failed: ${name}`);
    return { text: null, error: name };
  } finally {
    // Cover fetch plus full success-body consumption. Clearing this after
    // headers would allow a stalled JSON body to wait forever.
    clearTimeout(timeoutId);
  }
}

/**
 * JSON Mode 调用 + parse + 1 次 retry
 *
 * 失败返 null,调用方决定是否标 *_failed_at
 */
export async function callDeepSeekJson<T = unknown>(
  apiKey: string,
  model: string,
  prompt: string,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    retries?: number;        // 默认 1 次(总 2 attempts)
    systemPrompt?: string;
    requestId?: string;
  } = {},
): Promise<{
  data: T | null;
  usage?: DeepSeekUsage;
  diagnostics?: DeepSeekSafeDiagnostics;
  error?: string;
}> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff:2s, 4s, 8s...
      await new Promise((res) => setTimeout(res, 2000 * Math.pow(2, attempt - 1)));
    }
    const result = await callDeepSeek(apiKey, model, prompt, {
      ...opts,
      jsonMode: true,
    });
    if (!result.text) {
      if (attempt < retries) continue;
      return {
        data: null,
        usage: result.usage,
        diagnostics: result.diagnostics,
        error: result.error || 'no_text',
      };
    }
    try {
      const parsed = JSON.parse(result.text) as T;
      return { data: parsed, usage: result.usage, diagnostics: result.diagnostics };
    } catch {
      console.warn(`[hf-paper-llm] JSON parse fail attempt ${attempt + 1}`);
      if (attempt < retries) continue;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.text));
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      console.error(
        `[hf-paper-llm] invalid JSON model=${model} request=${opts.requestId || 'none'} length=${result.text.length} sha256=${hash}`,
      );
      return {
        data: null,
        usage: result.usage,
        diagnostics: result.diagnostics,
        error: 'json_parse_fail',
      };
    }
  }
  return { data: null, error: 'exhausted_retries' };
}

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

export interface DeepSeekResult {
  text: string | null;
  usage?: DeepSeekUsage;
  finish_reason?: string;
  error?: string;
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: DeepSeekUsage;
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
    clearTimeout(timeoutId);

    if (!resp.ok) {
      await resp.text();
      console.error(`[hf-paper-llm] DeepSeek HTTP ${resp.status}`);
      return { text: null, error: `HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as DeepSeekResponse;
    const text = data.choices?.[0]?.message?.content?.trim();
    const finish = data.choices?.[0]?.finish_reason;
    return {
      text: text || null,
      usage: data.usage,
      finish_reason: finish,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    const name = e instanceof Error ? e.name : 'unknown';
    console.error(`[hf-paper-llm] call failed: ${name}`);
    return { text: null, error: name };
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
): Promise<{ data: T | null; usage?: DeepSeekUsage; error?: string }> {
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
      return { data: null, usage: result.usage, error: result.error || 'no_text' };
    }
    try {
      const parsed = JSON.parse(result.text) as T;
      return { data: parsed, usage: result.usage };
    } catch {
      console.warn(`[hf-paper-llm] JSON parse fail attempt ${attempt + 1}`);
      if (attempt < retries) continue;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.text));
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      console.error(
        `[hf-paper-llm] invalid JSON model=${model} request=${opts.requestId || 'none'} length=${result.text.length} sha256=${hash}`,
      );
      return { data: null, usage: result.usage, error: 'json_parse_fail' };
    }
  }
  return { data: null, error: 'exhausted_retries' };
}

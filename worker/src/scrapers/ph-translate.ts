// worker/src/scrapers/ph-translate.ts
//
// Product Hunt 文本翻译原语（DeepSeek flash，走 CF AI Gateway）。
// 2026-07-06 从 ph.ts 抽出：ph.ts 运行时 import 了 '../index'（链上有 cloudflare:workers），
// 在 node vitest 里不可 import。把纯翻译封装（无 Env / 无 index 依赖，只用全局 fetch）单独放这里，
// 让 ph.ts（tagline / maker_post / comments / description 自动翻）和 ph-description-translate.ts
// （存量回填 mode）复用同一个 translatePhBatch，且回填模块可被单测覆盖。
//
// 逻辑跟原 ph.ts 内联版逐字一致，只是换了物理位置。

// 走 CF AI Gateway（slug：aifeeds-deepseek），dashboard 看 token / cost / 缓存命中。
// 回滚直连：改回 'https://api.deepseek.com/v1/chat/completions'。
export const DS_URL_TR = 'https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions';
export const DS_MODEL_TR = 'deepseek-v4-flash';
const NL_MARK_TR = '⟪NL⟫';

export function cjkRatioPh(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const c of text) {
    if (/\s/.test(c)) continue;
    total++;
    const code = c.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

export function isLikelyChinesePh(text: string): boolean {
  return !!text && cjkRatioPh(text) > 0.3;
}

const PH_TRANSLATE_PROMPT = `把下面每条 Product Hunt 产品文案或开发者帖文翻译成自然中文。

规则：
- 专有名词、人名、品牌名、产品名、模型名（GPT-4 / Claude / Cursor 等）保留英文
- 技术术语保留英文：fork / branch / merge / commit / PR / repo / push / pretrain / RLHF / prompt / embedding / RAG / LLM / API / SDK / CLI / IDE / CI/CD / OSS / MCP
- 'agent' → '智能体'（不是'代理'）
- 'token' → 'token'（不是'令牌'）
- 'fine-tune' → '微调'
- 代码/命令/URL/@handle 原样保留
- 输出自然口语化中文，避免直译腔
- 保留 ${NL_MARK_TR} 标记（代表换行）

每行格式：index:translated_text
不要加任何额外文字。

输入：
%INPUT%

输出：`;

// 单次 DeepSeek call 翻译 1 个 chunk(原 caller index 保留映射)。
// 跟原 translatePhBatch 同逻辑,只是 caller 拆 chunk 后调多次。
async function translatePhBatchChunk(
  apiKey: string,
  chunk: Array<{ origIdx: number; text: string }>,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (chunk.length === 0) return out;

  // chunk 内 0-based 重编号给 prompt 用;响应解析后映射回 origIdx
  const numbered = chunk
    .map((c, i) => `${i}:${c.text.replace(/\r\n/g, '\n').replace(/\n/g, NL_MARK_TR)}`)
    .join('\n');
  const prompt = PH_TRANSLATE_PROMPT.replace('%INPUT%', numbered);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    const resp = await fetch(DS_URL_TR, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DS_MODEL_TR,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 8000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.warn(`[ph] inline translate HTTP ${resp.status}`);
      return out;
    }
    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content || '';
    // 容错的格式 parse:N: / N： / **N:** / N.
    for (const line of text.split('\n')) {
      const m = line.match(/^\**\s*(\d+)\**\s*[:：.]\s*(.*?)\s*\**\s*$/);
      if (!m) continue;
      const chunkIdx = parseInt(m[1], 10);
      const c = chunk[chunkIdx];
      if (!c) continue;
      const tr = m[2].replace(new RegExp(NL_MARK_TR, 'g'), '\n').trim();
      if (tr) out.set(c.origIdx, tr);
    }
  } catch (e) {
    console.warn('[ph] inline translate error:', e instanceof Error ? e.message : String(e));
  }
  return out;
}

// translatePhBatch — 拆 chunk(每 chunk ≤ 5 个 task)防 max_tokens 截断尾部任务。
// 之前用 max_tokens=4000 + 一次发 10+ 任务,长 comments 撞 token 上限尾部不输出
// (prod 11 个 item 71 条 comment 未翻译的根因)。chunk 化让每次输出有足够空间。
export async function translatePhBatch(
  apiKey: string,
  texts: string[],
): Promise<Map<number, string>> {
  const CHUNK_SIZE = 5;
  const all = new Map<number, string>();
  for (let start = 0; start < texts.length; start += CHUNK_SIZE) {
    const chunk: Array<{ origIdx: number; text: string }> = [];
    for (let i = start; i < Math.min(start + CHUNK_SIZE, texts.length); i++) {
      chunk.push({ origIdx: i, text: texts[i] });
    }
    const partial = await translatePhBatchChunk(apiKey, chunk);
    for (const [k, v] of partial) all.set(k, v);
  }
  return all;
}

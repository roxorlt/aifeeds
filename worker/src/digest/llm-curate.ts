// 精选档 LLM rerank:从某源 top 候选里挑 M 条 + 一句话中文亮点。
// 模型 deepseek-v4-pro(跨条比较 + 判断价值,属推理任务)。复用 callDeepSeekJson(JSON Mode + retry)。
// 失败 fallback 纯综合分 top M(hook 留空)。设计文档:roxor-main-design-20260528-090625.md

import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import { SOURCE_LABELS } from './templates';
import type { DigestSource } from './config';

export interface CurateCandidate {
  id: string;
  title: string;
  summary: string;
}

interface CurateLLMResult {
  selected: { id: string; hook: string }[];
}

// 返回挑中的 id(有序)+ 每条的 hook。
export async function curateSource(
  env: Env,
  source: DigestSource,
  candidates: CurateCandidate[],
  target: number,
): Promise<{ ids: string[]; hooks: Record<string, string> }> {
  // 候选不足 target:全收,不调 LLM
  if (candidates.length <= target) {
    return { ids: candidates.map((c) => c.id), hooks: {} };
  }
  // 无 key(dev):fallback 纯分 top target
  if (!env.DEEPSEEK_API_KEY) {
    return { ids: candidates.slice(0, target).map((c) => c.id), hooks: {} };
  }

  const prompt = buildCuratePrompt(source, candidates, target);
  const { data } = await callDeepSeekJson<CurateLLMResult>(
    env.DEEPSEEK_API_KEY,
    DEEPSEEK_PRO,
    prompt,
    { retries: 2, maxTokens: 1500 },
  );

  // worker 端校验(DeepSeek 只保证 valid JSON,不保证 schema)
  if (data && Array.isArray(data.selected)) {
    const validIds = new Set(candidates.map((c) => c.id));
    const seen = new Set<string>();
    const picks = data.selected.filter((p) => {
      if (!p || typeof p.id !== 'string' || !validIds.has(p.id) || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    if (picks.length > 0) {
      const chosen = picks.slice(0, target);
      const hooks: Record<string, string> = {};
      for (const p of chosen) {
        if (typeof p.hook === 'string' && p.hook.trim()) hooks[p.id] = p.hook.trim().slice(0, 50);
      }
      return { ids: chosen.map((p) => p.id), hooks };
    }
  }

  // fallback:纯综合分 top target
  return { ids: candidates.slice(0, target).map((c) => c.id), hooks: {} };
}

function buildCuratePrompt(source: DigestSource, candidates: CurateCandidate[], target: number): string {
  const label = SOURCE_LABELS[source] || source;
  const list = candidates
    .map((c, i) => `${i + 1}. [id=${c.id}] ${c.title}${c.summary ? ' — ' + c.summary.slice(0, 120) : ''}`)
    .join('\n');
  return `你是 AI 资讯精选编辑。下面是「${label}」过去 24 小时的 ${candidates.length} 条候选。请挑出最值得 AI 从业者关注的 ${target} 条,并为每条写一句不超过 40 字的中文亮点(说清为什么值得看,不要复述标题)。

候选:
${list}

只返回 JSON,不要任何解释,格式:
{"selected":[{"id":"候选里的 id 原值","hook":"一句话中文亮点"}]}

要求:selected 恰好 ${target} 条;id 必须是候选里出现过的原值;hook 为中文且不超过 40 字。`;
}

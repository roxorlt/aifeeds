// 精选档 LLM rerank:从某源 top 候选挑 M 条 id。
// A 方案(PM 2026-05-29):邮件不显示单独"亮点",精选只体现"条数更少 + AI 选过",故不再生成 hook(省 token)。
// 模型 deepseek-v4-pro(跨条比较 + 判断价值,推理任务)。复用 callDeepSeekJson(JSON Mode + retry)。

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
  selected: string[];
}

// 返回挑中的 id(有序)。失败 fallback 纯综合分 top target。
export async function curateSource(
  env: Env,
  source: DigestSource,
  candidates: CurateCandidate[],
  target: number,
): Promise<string[]> {
  if (candidates.length <= target) return candidates.map((c) => c.id);
  if (!env.DEEPSEEK_API_KEY) return candidates.slice(0, target).map((c) => c.id);

  const prompt = buildCuratePrompt(source, candidates, target);
  const { data, error } = await callDeepSeekJson<CurateLLMResult>(
    env.DEEPSEEK_API_KEY,
    DEEPSEEK_PRO,
    prompt,
    { retries: 2, maxTokens: 3000 },
  );
  console.log(
    `[curate] ${source} cands=${candidates.length} ` +
      (data ? `selected=${data.selected?.length ?? 'nil'}` : `no_data err=${error}`),
  );

  if (data && Array.isArray(data.selected)) {
    const valid = new Set(candidates.map((c) => c.id));
    const uniq = [
      ...new Set(data.selected.filter((id) => typeof id === 'string' && valid.has(id))),
    ].slice(0, target);
    if (uniq.length) return uniq;
  }
  return candidates.slice(0, target).map((c) => c.id);
}

function buildCuratePrompt(source: DigestSource, candidates: CurateCandidate[], target: number): string {
  const label = SOURCE_LABELS[source] || source;
  const list = candidates
    .map((c, i) => `${i + 1}. [id=${c.id}] ${c.title}${c.summary ? '\n   ' + c.summary : ''}`)
    .join('\n\n');
  return `你是 AI 资讯精选编辑。下面是「${label}」过去 24 小时的 ${candidates.length} 条候选,已按热度(互动量/star/upvotes/排名)从高到低排序——**序号即热度排名,1 最热**。

请综合「内容价值」与「热度」挑出最值得 AI 从业者关注的 ${target} 条:热度是重要参考(高热往往代表关注度),但不必严格按序号,优质但稍冷门的也可入选。只返回 JSON,不要解释:
{"selected":["候选的 id 原值", ...]}

要求:selected 恰好 ${target} 个 id,必须是候选里出现过的原值。

候选(按热度降序):
${list}`;
}

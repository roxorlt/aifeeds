// 各源 enrich 收尾 → item 单页联动（Task 5）。
// 各源 pipeline 在「内容最终态」（翻译 + 封面齐、is_relevant 已定）后调本函数：
//   relevant  → generateItemPage（生成/覆盖静态页 + item_pages 置 live）
//   !relevant → markItemPageGone（下架：item_pages 置 gone；无行则 no-op，用于改判 1→0 / dedup 次源）
//
// 关键契约：**非阻塞容错**——整块 try/catch，异常只 console.error，绝不 throw，
// 保证 item 页生成/下架失败不阻断各源 enrich 主流程（页缺失由 backfill mode 兜底自愈）。
//
// 为何独立成文件：各 pipeline 是 WorkflowEntrypoint（import 'cloudflare:workers'），
// vitest 无法直接导入；把挂载逻辑抽到本纯函数，pipeline 调它、测试测它（item-page-hook.test.ts）。

import type { Env } from '../index';
import { generateItemPage, markItemPageGone } from './item-page-run';

export async function syncItemPageOnEnrichDone(
  env: Env,
  id: string,
  relevant: boolean,
): Promise<void> {
  try {
    if (relevant) {
      await generateItemPage(env, id);
    } else {
      await markItemPageGone(env, id);
    }
  } catch (e) {
    console.error(`[item-page-hook] ${id}: sync failed (non-blocking)`, e);
  }
}

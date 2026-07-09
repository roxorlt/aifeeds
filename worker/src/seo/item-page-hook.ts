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
import { pingIndexNow } from '../digest/daily-page-run';
import { getBases } from '../digest/lib';
import { itemPagePath } from '../digest/render';

export async function syncItemPageOnEnrichDone(
  env: Env,
  id: string,
  relevant: boolean,
): Promise<void> {
  try {
    if (!relevant) {
      await markItemPageGone(env, id);
      return;
    }
    const res = await generateItemPage(env, id);

    // IndexNow ping：只对「首次 live 的新页」提交，加速 Bing / Yandex 收录。
    // - skipped（被 dedup 门 / is_relevant 门 / 源 gate 拦下）→ 无页可推。
    // - created=false（re-enrich / metrics 刷新 / 重译覆盖已有行）→ URL 已收录，不重推。
    // 只挂 hook 层、不挂 generateItemPage 本体，是为了让 backfill / force 全量重灌（3.2 万存量）
    // 绝不触发 ping —— 存量靠 sitemap-index 收录即可。pingIndexNow 本身 fire-and-forget 永不抛错，
    // 外层 try/catch 再兜一层，ping 失败绝不阻断 enrich 主流程。
    if (res.skipped || !res.created) return;
    const path = itemPagePath(id);
    if (!path) return; // 不支持源的防御（正常 !skipped 已保证 path 非空，双保险防崩）
    // 绝对 URL 必须走 env 域（SITE_BASE），不用 request host —— 香港中转会把 Host 改成 workers.dev。
    const { siteBase } = getBases(env);
    await pingIndexNow(env, [`${siteBase}${path}`]);
  } catch (e) {
    console.error(`[item-page-hook] ${id}: sync failed (non-blocking)`, e);
  }
}

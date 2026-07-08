// item 页生成编排（Task 4 交付）—— 本文件当前是 Task 3 落地时的最小 stub，仅为让伺服路由
// （item-routes.ts 的 R2-miss 兜底路径）能按签名 import + 编译通过。Task 4 会整文件覆盖为真实实现：
//   render(fetchItemRow) → R2 put items/<source>/<safe>.html → item_pages upsert(status=live)。
// stub 阶段固定返回 skipped，使兜底路径在 Task 4 落地前优雅降级为 404，而不是崩。
import type { Env } from '../index';

export interface ItemPageRunResult {
  itemId: string;
  skipped: boolean;
  reason?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function generateItemPage(
  env: Env,
  id: string,
  _opts?: { dry?: boolean },
): Promise<ItemPageRunResult> {
  return { itemId: id, skipped: true, reason: 'stub-not-implemented' };
}

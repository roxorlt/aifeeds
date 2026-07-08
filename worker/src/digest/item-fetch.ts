// 按 composite id（`${source_type}:${source_id}`）取单条 items 行。
// 从 index.ts 的 handleItemById 抽出，供 /api/items/:id 详情 API 与 item SSR 静态页共用。
// 纯取数：只做 SELECT * FROM items WHERE id = ?，不做 cn_sensitive 过滤 / thread 组装 —
//        这些语义由各调用方按自身出口需要处理。
// 独立成文件（对 index.ts 只有 type-only 依赖），避免测试因 index.ts 传递依赖
// 'cloudflare:workers'（workflow 类）而无法在 node/vitest 环境导入。
import type { Env } from '../index';
import type { RenderRow } from './render';

export async function fetchItemRow(env: Env, id: string): Promise<RenderRow | null> {
  return env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<RenderRow>();
}

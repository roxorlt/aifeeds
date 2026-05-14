// aifeeds D1 备份 worker entry。
//
// 职责：
//   - scheduled() — 每天 BJT 12:30 (UTC 04:30) 自动触发 D1BackupWorkflow
//   - fetch() — 暴露 /trigger 手动触发入口（无鉴权，仅 workers.dev 子域可达；
//     如未来要绑自定义域，需加 token check）
//
// Workflow 实现见 src/backup.ts。

import { D1BackupWorkflow } from './backup';

// re-export 让 wrangler [[workflows]] class_name 能找到
export { D1BackupWorkflow };

export interface Env {
  D1_BACKUP_WORKFLOW: Workflow;
  BACKUP_BUCKET: R2Bucket;
  D1_BACKUP_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const instance = await env.D1_BACKUP_WORKFLOW.create();
    console.log(`[backup-cron] triggered workflow instance ${instance.id}`);
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 手动触发入口 — 用于 deploy 后第一次验证 / cron 漏跑后人工补
    if (url.pathname === '/trigger' && req.method === 'POST') {
      const instance = await env.D1_BACKUP_WORKFLOW.create();
      return new Response(
        JSON.stringify({ ok: true, instance_id: instance.id, status: await instance.status() }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 查实例状态：GET /status/<instance_id>
    if (url.pathname.startsWith('/status/') && req.method === 'GET') {
      const id = url.pathname.slice('/status/'.length);
      const instance = await env.D1_BACKUP_WORKFLOW.get(id);
      return new Response(JSON.stringify(await instance.status()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      [
        'aifeeds-d1-backup worker',
        '',
        'POST /trigger          — 立即触发一次 D1 备份',
        'GET  /status/<id>      — 查 workflow instance 状态',
        '',
        'Cron: 每天 BJT 12:30 (UTC 04:30) 自动触发，落到 R2 daily/<BJT-date>.sql',
      ].join('\n'),
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },
};

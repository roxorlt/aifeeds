// D1 备份 Workflow — 调 CF D1 REST export API 拿 SQL dump，存到 R2。
//
// 流程（CF 官方推荐 polling pattern，see https://developers.cloudflare.com/workflows/examples/backup-d1/）：
//   1. POST /export {output_format:"polling"} → 拿 at_bookmark
//   2. 循环 POST /export {current_bookmark} 直到响应里出现 signed_url
//      （CF 在后台异步生成 dump，可能要几秒到几分钟）
//   3. fetch signed_url 拿 SQL 流 → R2.put(daily/<BJT-date>.sql)
//
// step.do 自带重试 — 单 step 抛错自动按 retries config 重试，全部失败才整个 workflow fail。
// 我们把整个"轮询 + 下载 + 写 R2"作为单个 step（step 2），让 step.do 的 retry 替我们做轮询，
// 不用手写 setTimeout 循环（worker 没有真正的 sleep，只能借 step retry 间隔）。

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

interface BackupParams {
  // 预留 — 未来可选指定备份目标 db / 输出 prefix
  // 当前实现只用 env binding 的 D1_DATABASE_ID
}

interface BackupEnv {
  BACKUP_BUCKET: R2Bucket;
  D1_BACKUP_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
}

interface CFD1ExportResult {
  result?: {
    at_bookmark?: string;
    signed_url?: string;
    filename?: string;
    messages?: string[];
    success?: boolean;
  };
  errors?: Array<{ code: number; message: string }>;
  success?: boolean;
}

/** 把当前时刻按 BJT (UTC+8) 格式化为 YYYY-MM-DD，作为 R2 object key */
function bjtDateStr(now: Date = new Date()): string {
  const bjt = new Date(now.getTime() + 8 * 3600 * 1000);
  return bjt.toISOString().slice(0, 10);
}

export class D1BackupWorkflow extends WorkflowEntrypoint<BackupEnv, BackupParams> {
  async run(_event: WorkflowEvent<BackupParams>, step: WorkflowStep): Promise<{ key: string; size: number }> {
    const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/d1/database/${this.env.D1_DATABASE_ID}/export`;
    const headers = {
      Authorization: `Bearer ${this.env.D1_BACKUP_API_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // ─── Step 1: 启动 export，拿 bookmark ────────────────────────
    const bookmark = await step.do(
      'Start D1 export',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
      async () => {
        const res = await fetch(exportUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ output_format: 'polling' }),
        });
        const data = (await res.json()) as CFD1ExportResult;
        if (!res.ok || !data.success) {
          throw new Error(`D1 export init failed: HTTP ${res.status} body=${JSON.stringify(data)}`);
        }
        const bk = data.result?.at_bookmark;
        if (!bk) {
          throw new Error(`D1 export init missing at_bookmark: ${JSON.stringify(data)}`);
        }
        return bk;
      },
    );

    // ─── Step 2: 轮询直到 signed_url 出现，下载并写 R2 ─────────────
    // 用 step.do 的 retry 机制实现轮询：未 ready 时 throw，CF 自动按 delay 间隔重试。
    // 30 retries × 20s = 最长 10 分钟轮询。140MB DB dump 通常 10-30s 完成。
    const result = await step.do(
      'Poll export status, download dump, save to R2',
      {
        retries: { limit: 30, delay: '20 seconds', backoff: 'constant' },
        timeout: '15 minutes',
      },
      async () => {
        // 2a. Poll
        const res = await fetch(exportUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ current_bookmark: bookmark }),
        });
        const data = (await res.json()) as CFD1ExportResult;
        if (!res.ok) {
          throw new Error(`D1 export poll failed: HTTP ${res.status} body=${JSON.stringify(data)}`);
        }
        const signedUrl = data.result?.signed_url;
        if (!signedUrl) {
          // CF 还在生成 dump — throw 触发 step.do 按 delay 重试
          throw new Error(`D1 export not ready, retrying (messages=${JSON.stringify(data.result?.messages ?? [])})`);
        }

        // 2b. Download dump
        const dumpRes = await fetch(signedUrl);
        if (!dumpRes.ok || !dumpRes.body) {
          throw new Error(`Failed to fetch signed_url: HTTP ${dumpRes.status}`);
        }

        // 2c. Write R2 (按 BJT 日期命名，保证一天一份；同日多次触发会覆盖)
        const key = `daily/${bjtDateStr()}.sql`;
        const putResult = await this.env.BACKUP_BUCKET.put(key, dumpRes.body, {
          httpMetadata: { contentType: 'application/sql' },
          customMetadata: {
            bookmark,
            captured_at: new Date().toISOString(),
            d1_database_id: this.env.D1_DATABASE_ID,
            cf_filename: data.result?.filename ?? '',
          },
        });

        return { key, size: putResult.size };
      },
    );

    console.log(`[d1-backup] saved ${result.key} (${result.size} bytes)`);
    return result;
  }
}

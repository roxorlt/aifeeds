// digest-deliver workflow:per-subscription 投递。幂等 → 选品(读 pool) → 渲染 → 投递 → 记账调度。
// 由 node-run Phase 2 create(id=digest-{slotKey}-{subId},唯一 = 幂等防重复 create)。
// 设计文档:roxor-main-design-20260528-090625.md

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import { sendEmail } from '../auth/resend';
import { DIGEST_SOURCE_ORDER, type DigestSource, type Density } from './config';
import { nextSendAt, genEmailToken } from './lib';
import { buildDigestEmail, type DigestItem } from './templates';

interface DeliverParams {
  subId: number;
  slotKey: string;
}

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' as const },
  timeout: '3 minutes',
} as const;

const SITE = 'https://ai-feeds.com';
const REPLY_TO = 'support@mail.ai-feeds.com';

interface SubRow {
  id: number;
  email: string;
  sources: string;
  send_slot: number;
  density: string;
  status: string;
  unsubscribe_token: string;
}

interface ItemRow {
  id: string;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  author: string | null;
  handle: string | null;
  url: string | null;
  media: string | null;
  extra: string | null;
}

// item.id(<source_type>:<source_id>)→ aifeeds 抽屉深链 path(对齐 dashboard parseDeepLinkFromPath)
function deepLinkPath(itemId: string): string {
  const idx = itemId.indexOf(':');
  if (idx < 0) return '/';
  const st = itemId.slice(0, idx);
  const sid = itemId.slice(idx + 1);
  switch (st) {
    case 'x_list':
      return `/t/${encodeURIComponent(sid)}`;
    case 'github': {
      const [o, r] = sid.split('/');
      return o && r ? `/g/${encodeURIComponent(o)}/${encodeURIComponent(r)}` : '/';
    }
    case 'product_hunt': {
      const [slug, date] = sid.split(':');
      return slug && date ? `/ph/${encodeURIComponent(slug)}/${encodeURIComponent(date)}` : '/';
    }
    case 'clawhub':
      return `/c/${encodeURIComponent(sid)}`;
    case 'hf_paper':
      return `/h/${encodeURIComponent(sid)}`;
    default:
      return '/';
  }
}

function toDigestItem(source: DigestSource, row: ItemRow, hook: string | undefined): DigestItem {
  let cover: string | undefined;
  let aiSummary: string | undefined;
  try {
    const ex = JSON.parse(row.extra || '{}') as Record<string, unknown>;
    cover = (ex.cover_image as string) || (ex.video_thumbnail as string) || undefined;
    aiSummary = ex.ai_summary as string | undefined;
  } catch {
    /* ignore */
  }
  const body = row.content_translated || row.content || '';
  // X 推文无 title:优先用 ai_summary(简洁),否则正文开头
  const title = row.title || aiSummary || body.slice(0, 80) || '(无标题)';
  return {
    source,
    title,
    summary: body.slice(0, 120),
    url: row.url || SITE,
    deepLinkPath: deepLinkPath(row.id),
    author: row.author || row.handle || '',
    hook: hook || null,
    cover,
  };
}

export class DigestDeliverWorkflow extends WorkflowEntrypoint<Env, DeliverParams> {
  async run(event: WorkflowEvent<DeliverParams>, step: WorkflowStep) {
    const { subId, slotKey: sk } = event.payload;

    // Step 0:幂等(今天这个 slot 已 sent 则跳过)
    const alreadySent = await step.do('idempotency', RETRY, async (): Promise<boolean> => {
      const r = await this.env.DB.prepare(
        `SELECT 1 FROM digest_send_log WHERE subscription_id = ? AND slot_key = ? AND status = 'sent' LIMIT 1`,
      )
        .bind(subId, sk)
        .first();
      return !!r;
    });
    if (alreadySent) return { subId, skipped: 'already_sent' };

    const sub = await step.do('load-sub', RETRY, async (): Promise<SubRow | null> => {
      return await this.env.DB.prepare(
        `SELECT id, email, sources, send_slot, density, status, unsubscribe_token
         FROM subscriptions WHERE id = ? AND status IN ('active','paused')`,
      )
        .bind(subId)
        .first<SubRow>();
    });
    if (!sub) return { subId, skipped: 'no_active_sub' };

    const sources = safeParseArray<DigestSource>(sub.sources);
    const density = sub.density as Density;

    // Step 1:选品(每源各取,读 pool;无 LLM)
    const collected = await step.do('collect', RETRY, async () => {
      const items: DigestItem[] = [];
      const subjRow = await this.env.DB.prepare(
        `SELECT items_meta FROM digest_pool WHERE slot_key = ? AND source = '_subject' AND density = 'meta'`,
      )
        .bind(sk)
        .first<{ items_meta: string | null }>();
      let subject = '今日 AI 精选';
      try {
        subject = (JSON.parse(subjRow?.items_meta || '{}').subject as string) || subject;
      } catch {
        /* ignore */
      }

      for (const source of DIGEST_SOURCE_ORDER) {
        if (!sources.includes(source)) continue;
        const pool = await this.env.DB.prepare(
          `SELECT item_ids, items_meta FROM digest_pool WHERE slot_key = ? AND source = ? AND density = ?`,
        )
          .bind(sk, source, density)
          .first<{ item_ids: string; items_meta: string | null }>();
        if (!pool) continue;
        const ids = safeParseArray<string>(pool.item_ids);
        if (!ids.length) continue;
        const hooks = safeParseObj(pool.items_meta);
        const ph = ids.map(() => '?').join(',');
        const r = await this.env.DB.prepare(
          `SELECT id, title, content, content_translated, author, handle, url, media, extra FROM items WHERE id IN (${ph})`,
        )
          .bind(...ids)
          .all<ItemRow>();
        const byId = new Map((r.results || []).map((row) => [row.id, row]));
        for (const id of ids) {
          const row = byId.get(id);
          if (row) items.push(toDigestItem(source, row, hooks[id]));
        }
      }
      return { items, subject };
    });

    // Empty 兜底:记 no_items + 跳到明天该节点
    if (!collected.items.length) {
      await step.do('no-items', RETRY, async () => {
        await this.env.DB.prepare(
          `INSERT INTO digest_send_log (subscription_id, slot_key, sent_at, items_count, status) VALUES (?, ?, ?, 0, 'no_items')`,
        )
          .bind(subId, sk, Date.now())
          .run();
        await this.env.DB.prepare(`UPDATE subscriptions SET next_send_at = ? WHERE id = ?`)
          .bind(nextSendAt(sub.send_slot), subId)
          .run();
      });
      return { subId, status: 'no_items' };
    }

    // Step 2:渲染
    const mail = await step.do('render', RETRY, async () => {
      const token = await genEmailToken(this.env, sub.email, subId);
      const unsubUrl = `${SITE}/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;
      return buildDigestEmail({
        subject: collected.subject,
        items: collected.items,
        emailToken: token,
        unsubscribeUrl: unsubUrl,
      });
    });

    // Step 3:投递(sendEmail 失败抛错触发 step RETRY;耗尽则 catch 记 failed + 计数)
    const unsubUrl = `${SITE}/unsubscribe?token=${encodeURIComponent(sub.unsubscribe_token)}`;
    try {
      const sendRes = await step.do('send', RETRY, async () => {
        const r = await sendEmail(this.env, {
          to: sub.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          replyTo: REPLY_TO,
        });
        if (!r.ok) throw new Error(`resend_${r.errCode || 'fail'}`);
        return r;
      });
      await step.do('record-success', RETRY, async () => {
        await this.env.DB.prepare(
          `INSERT INTO digest_send_log (subscription_id, slot_key, sent_at, items_count, status, resend_message_id) VALUES (?, ?, ?, ?, 'sent', ?)`,
        )
          .bind(subId, sk, Date.now(), collected.items.length, sendRes.id || null)
          .run();
        await this.env.DB.prepare(
          `UPDATE subscriptions SET last_sent_at = ?, next_send_at = ?, worker_send_failures = 0 WHERE id = ? AND status IN ('active','paused')`,
        )
          .bind(Date.now(), nextSendAt(sub.send_slot), subId)
          .run();
      });
      return { subId, status: 'sent', count: collected.items.length };
    } catch (err) {
      // 投递重试耗尽:记 failed,worker_send_failures++,>=5 → paused(防 Resend 故障 mass-kick)
      await step.do('record-fail', RETRY, async () => {
        await this.env.DB.prepare(
          `INSERT INTO digest_send_log (subscription_id, slot_key, sent_at, items_count, status, error_message) VALUES (?, ?, ?, ?, 'failed_resend', ?)`,
        )
          .bind(subId, sk, Date.now(), collected.items.length, String(err).slice(0, 200))
          .run();
        await this.env.DB.prepare(
          `UPDATE subscriptions
           SET worker_send_failures = worker_send_failures + 1,
               next_send_at = ?,
               status = CASE WHEN worker_send_failures + 1 >= 5 AND status = 'active' THEN 'paused' ELSE status END
           WHERE id = ?`,
        )
          .bind(nextSendAt(sub.send_slot), subId)
          .run();
      });
      return { subId, status: 'failed_resend' };
    }
  }
}

function safeParseArray<T>(s: string | null): T[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
function safeParseObj(s: string | null): Record<string, string> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

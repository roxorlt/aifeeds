// PR-EmailAuth：Resend HTTPS API client
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 9.1
// dev fallback：缺 RESEND_API_KEY 时走 PushDeer 推到 admin（与 SMS PushDeer fallback 同模式）

import type { Env } from '../index';
import { pushDeerAlert } from '../notifier';

const RESEND_API = 'https://api.resend.com/emails';

interface SendEmailResult {
  ok: boolean;
  id?: string;
  errCode?: string;
  errMsg?: string;
}

function buildEmailText(code: string): string {
  return [
    '【AI Feeds】',
    '',
    `验证码：${code}`,
    '',
    '5 分钟内有效，请勿告诉他人。',
    '',
    '如果不是你本人操作，请忽略此邮件。',
    '',
    '---',
    'AI Feeds（https://ai-feeds.com）',
  ].join('\n');
}

/** dev / 冷启动期 fallback：RESEND_API_KEY 缺失时把验证码推到 admin PushDeer */
async function sendEmailViaPushDeer(env: Env, to: string, code: string): Promise<SendEmailResult> {
  if (!env.PUSHDEER_ADMIN_KEYS) {
    console.warn(`[email] dev simulate（无 RESEND_API_KEY 也无 PUSHDEER_ADMIN_KEYS）to=${to} code=${code}`);
    return { ok: true, id: `dev-simulated-${Date.now()}` };
  }
  await pushDeerAlert(
    env,
    'AI Feeds 验证码',
    `email：${to}\n\n**${code}**\n\n5 分钟有效。如非本人请求请忽略。`,
  );
  return { ok: true, id: `pushdeer-${Date.now()}` };
}

export async function sendEmailViaResend(
  env: Env,
  to: string,
  code: string,
): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    return sendEmailViaPushDeer(env, to, code);
  }

  const from = env.EMAIL_FROM || 'AI Feeds <noreply@mail.ai-feeds.com>';

  let r: Response;
  try {
    r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject: `你的登录验证码：${code}`,
        text: buildEmailText(code),
      }),
    });
  } catch (e) {
    return { ok: false, errCode: 'NETWORK', errMsg: String(e).slice(0, 200) };
  }

  if (!r.ok) {
    const errMsg = await r.text().catch(() => '');
    return { ok: false, errCode: String(r.status), errMsg: errMsg.slice(0, 200) };
  }

  const data = (await r.json()) as { id?: string };
  return { ok: true, id: data.id || 'no-id' };
}

// ── 通用发信(订阅 digest / welcome / 确认邮件复用;支持 HTML + 自定义 header)──

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>; // 如 List-Unsubscribe / List-Unsubscribe-Post(RFC 8058)
  replyTo?: string;
}

export async function sendEmail(env: Env, opts: SendEmailOptions): Promise<SendEmailResult> {
  // dev / 冷启动:无 RESEND_API_KEY 不真发(避免本地误发),只 log。
  if (!env.RESEND_API_KEY) {
    console.warn(`[email] dev simulate sendEmail to=${opts.to} subject="${opts.subject}"`);
    return { ok: true, id: `dev-simulated-${Date.now()}` };
  }
  const from = env.EMAIL_FROM || 'AI Feeds <noreply@mail.ai-feeds.com>';
  const payload: Record<string, unknown> = {
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  };
  if (opts.html) payload.html = opts.html;
  if (opts.replyTo) payload.reply_to = opts.replyTo;
  if (opts.headers) payload.headers = opts.headers;

  let r: Response;
  try {
    r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, errCode: 'NETWORK', errMsg: String(e).slice(0, 200) };
  }
  if (!r.ok) {
    const errMsg = await r.text().catch(() => '');
    return { ok: false, errCode: String(r.status), errMsg: errMsg.slice(0, 200) };
  }
  const data = (await r.json()) as { id?: string };
  return { ok: true, id: data.id || 'no-id' };
}

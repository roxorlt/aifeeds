// 订阅推送邮件模板。welcome 邮件(订阅即时发)在此;digest 正式日报模板见 deliver 阶段。
// ⚠️ 视觉规格(色/字/间距/卡片结构)待 FE 出规格后替换 BRAND/FONT 常量与卡片布局。
// 邮件 HTML 约束:table 布局 + inline CSS + 无 JS,跨客户端兼容(Gmail/Outlook/Apple/QQ/163)。

import { DIGEST_SOURCE_ORDER, type DigestSource, type Density } from './config';

// 占位品牌色,待 FE 规格替换。
const BRAND = {
  text: '#1a1a1a',
  sub: '#6b7280',
  accent: '#2563eb',
  border: '#e5e7eb',
  bg: '#f6f7f9',
  card: '#ffffff',
};
const FONT = `'HarmonyOS Sans SC','PingFang SC',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;

export const SOURCE_LABELS: Record<DigestSource, string> = {
  'ph': 'Product Hunt',
  'gh': 'GitHub Trending',
  'hf-paper': 'HuggingFace 论文',
  'clawhub': 'ClawHub',
  'x': 'X 精选',
};

export function slotLabel(bjt: number): string {
  if (bjt < 12) return `早上 ${bjt}:00`;
  if (bjt === 12) return '中午 12:00';
  if (bjt < 18) return `下午 ${bjt}:00`;
  return `晚上 ${bjt}:00`;
}

export function densityLabel(d: Density): string {
  return d === 'curated' ? '精选档(AI 优选,更少更精)' : '默认档(每个来源各取前几条)';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sourcesLine(sources: DigestSource[]): string {
  const ordered = DIGEST_SOURCE_ORDER.filter((s) => sources.includes(s));
  return ordered.map((s) => SOURCE_LABELS[s]).join(' · ');
}

export interface WelcomeEmailInput {
  sources: DigestSource[];
  slotBjt: number;
  density: Density;
  confirmUrl: string | null; // 回流确认注册按钮;无 HMAC secret 时 null(不放按钮)
  unsubscribeUrl: string;
}

export function buildWelcomeEmail(input: WelcomeEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const srcText = sourcesLine(input.sources);
  const when = slotLabel(input.slotBjt);
  const dens = densityLabel(input.density);

  const subject = '欢迎订阅 AI Feeds 每日精选';

  const text = [
    '【AI Feeds】欢迎订阅每日精选',
    '',
    `你已订阅:${srcText}`,
    `推送时间:每天 ${when}(北京时间)`,
    `内容档位:${dens}`,
    '',
    '下一个推送时间点,你会收到第一封正式日报。',
    input.confirmUrl ? `\n确认并进站看看:${input.confirmUrl}` : '',
    '',
    `不想再收到?一键退订:${input.unsubscribeUrl}`,
    '',
    'AI Feeds · https://ai-feeds.com',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const confirmBtn = input.confirmUrl
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${input.confirmUrl}" style="display:inline-block;background:${BRAND.accent};color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 22px;border-radius:8px;">确认并进站看看 →</a>
       </td></tr>`
    : '';

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;font-family:${FONT};">
    <tr><td style="padding:28px 28px 8px;">
      <div style="font-size:20px;font-weight:700;color:${BRAND.text};">AI Feeds</div>
      <div style="font-size:13px;color:${BRAND.sub};margin-top:2px;">每日 AI 多源精选</div>
    </td></tr>
    <tr><td style="padding:8px 28px 4px;">
      <div style="font-size:17px;font-weight:600;color:${BRAND.text};">订阅成功</div>
      <p style="font-size:14px;line-height:1.7;color:${BRAND.text};margin:12px 0 0;">
        你已订阅 <strong>${escapeHtml(srcText)}</strong>，每天 <strong>${escapeHtml(when)}</strong>（北京时间）推送，档位为 ${escapeHtml(dens)}。
      </p>
      <p style="font-size:14px;line-height:1.7;color:${BRAND.sub};margin:8px 0 0;">
        下一个推送时间点，你会收到第一封正式日报。
      </p>
    </td></tr>
    <tr><td style="padding:12px 28px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0">${confirmBtn}</table>
    </td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid ${BRAND.border};">
      <div style="font-size:12px;color:${BRAND.sub};line-height:1.6;">
        不想再收到？<a href="${input.unsubscribeUrl}" style="color:${BRAND.sub};">一键退订</a>。
        <br>AI Feeds · <a href="https://ai-feeds.com" style="color:${BRAND.sub};">ai-feeds.com</a>
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

// ── digest 正式日报邮件 ──

export interface DigestItem {
  source: DigestSource;
  title: string;
  summary: string;
  url: string;
  author: string;
  hook: string | null;
  cover?: string;
}

export interface DigestEmailInput {
  subject: string; // 节点标题摘要(不含日期前缀)
  items: DigestItem[];
  emailToken: string | null; // footer 进站按钮回流 token
  unsubscribeUrl: string;
}

function cnDate(ts = Date.now()): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function renderCard(it: DigestItem): string {
  const author = it.author ? `${escapeHtml(it.author)} · ` : '';
  const hook = it.hook
    ? `<div style="font-size:13px;color:${BRAND.accent};margin-top:4px;line-height:1.5;">${escapeHtml(it.hook)}</div>`
    : '';
  const cover = it.cover
    ? `<img src="${escapeHtml(it.cover)}" width="100%" style="max-width:544px;border-radius:8px;margin-top:8px;display:block;" alt="" />`
    : '';
  return `<tr><td style="padding:8px 28px;">
    <a href="${escapeHtml(it.url)}" style="text-decoration:none;color:inherit;display:block;">
      <div style="font-size:15px;font-weight:600;color:${BRAND.text};line-height:1.45;">${escapeHtml(it.title)}</div>
      <div style="font-size:13px;color:${BRAND.sub};margin-top:3px;line-height:1.5;">${author}${escapeHtml(it.summary)}</div>
      ${hook}
      ${cover}
    </a>
  </td></tr>`;
}

export function buildDigestEmail(input: DigestEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `${cnDate()} · ${input.subject}`;

  const groups: Partial<Record<DigestSource, DigestItem[]>> = {};
  for (const it of input.items) (groups[it.source] ||= []).push(it);
  const orderedSources = DIGEST_SOURCE_ORDER.filter((s) => groups[s]?.length);

  // text 版
  const textParts = [`【AI Feeds】${subject}`, ''];
  for (const s of orderedSources) {
    textParts.push(`## ${SOURCE_LABELS[s]}`);
    for (const it of groups[s]!) {
      textParts.push(`- ${it.title}${it.hook ? `（${it.hook}）` : ''}\n  ${it.url}`);
    }
    textParts.push('');
  }
  textParts.push(`管理订阅 / 退订:${input.unsubscribeUrl}`);
  const text = textParts.join('\n');

  // html 版
  const enterUrl = input.emailToken
    ? `https://ai-feeds.com/api/digest/return?u=${encodeURIComponent(input.emailToken)}`
    : 'https://ai-feeds.com';
  let sections = '';
  for (const s of orderedSources) {
    sections += `<tr><td style="padding:18px 28px 2px;"><div style="font-size:13px;font-weight:700;color:${BRAND.accent};letter-spacing:.5px;">${escapeHtml(SOURCE_LABELS[s])}</div></td></tr>`;
    for (const it of groups[s]!) sections += renderCard(it);
  }

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;font-family:${FONT};">
    <tr><td style="padding:24px 28px 4px;">
      <div style="font-size:20px;font-weight:700;color:${BRAND.text};">AI Feeds</div>
      <div style="font-size:13px;color:${BRAND.sub};margin-top:2px;">${escapeHtml(subject)}</div>
    </td></tr>
    ${sections}
    <tr><td style="padding:20px 28px 24px;border-top:1px solid ${BRAND.border};margin-top:12px;">
      <a href="${enterUrl}" style="display:inline-block;background:${BRAND.accent};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">进站看全部 →</a>
      <div style="font-size:12px;color:${BRAND.sub};line-height:1.6;margin-top:14px;">
        <a href="${input.unsubscribeUrl}" style="color:${BRAND.sub};">退订</a> · AI Feeds · <a href="https://ai-feeds.com" style="color:${BRAND.sub};">ai-feeds.com</a>
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

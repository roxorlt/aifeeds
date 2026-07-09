// item SSR 单页「分源混合正文」渲染（纯函数）。设计文档 2026-07-08-item-page-fulltext-plan.md § 分源内容模型 + Task 2。
//
// renderItemBody(source, row, env) —— 按源渲染 /i/ 内容页的正文 HTML（净化后，零可执行 script）：
//   gh / hf / ph / x  = 全文（README / deep_analysis / maker+评论 / 推文串+引用）
//   blog / podcast    = 我们的摘要 + 分析 + **短摘录**（首 ~800 字，clampSentences，绝不整篇照译）
//                       + 显著「阅读原文」出处链 —— 规避采集站 / DMCA 风险
//
// 安全底线：任何第三方 / 译文字段一律经净化后才落页。
//   - markdown 字段（gh README、hf deep_analysis 各维、ph 评论 body_html）走 Task 1 markdownToSafeHtml
//     （marked → allowlist 净化，剥 script/style/iframe/on*=/javascript:）。
//   - 纯文本字段（推文 / maker post / 摘要 / 摘录）一律 escapeHtml 转义后落页。
//   - README / md 输出的标题统一降一级（h1→h2…），保证页面 h1 唯一（页头标题独占 h1）。
//   - README / md 输出的 <img> 统一补 loading="lazy"（净化层白名单不含 loading，故渲染后注入）。
//
// itemIndexableText(source, row, env) —— 供 JSON-LD Article.articleBody 的**可安全索引**纯文本：
//   全文源用正文派生文本；blog/podcast 只用「我们的摘要 + 分析」，不含照译全文。

import type { Env } from '../index';
import type { DigestSource } from '../digest/config';
import { getBases } from '../digest/lib';
import { clampSentences, cleanText, type RenderRow } from '../digest/render';
import { escapeHtml } from '../digest/templates';
import { markdownToSafeHtml } from './markdown-html';

// ── 尺寸上限 ───────────────────────────────────────────────────────────────────
const GH_README_MAX_CHARS = 40_000; // markdown 源字符上限（渲染后 ~40KB HTML，超则截断 + 原文链）
const BLOG_EXCERPT_MAX = 800; // blog 正文摘录上限（按句 clamp，非全文）
const PODCAST_SHOWNOTES_MAX = 800; // podcast 节目简介摘录上限
const BLOG_ANALYSIS_MAX = 400; // blog 二级摘要（要点）上限
const PH_COMMENT_MAX = 6; // PH 热门评论条数
const INDEXABLE_MAX = 4_000; // articleBody 纯文本上限

// ── 对外接口 ───────────────────────────────────────────────────────────────────

// 分源正文 HTML（不含 h1/封面/元信息/CTA；这些由 item-page.ts 框架负责）。
export function renderItemBody(source: DigestSource, row: RenderRow, env: Env): string {
  const { apiBase } = getBases(env);
  const ex = safeParse(row.extra);
  switch (source) {
    case 'gh':
      return renderGh(row, ex, apiBase);
    case 'hf-paper':
      return renderHf(row, ex);
    case 'ph':
      return renderPh(row, ex);
    case 'x':
      return renderX(row, ex);
    case 'news':
      return !!ex.show_key ? renderPodcast(row, ex) : renderBlog(row, ex);
    default:
      return renderFallback(row, ex);
  }
}

// JSON-LD Article.articleBody 的可安全索引纯文本。blog/podcast 只放我们的摘要+分析（不照译全文）。
export function itemIndexableText(source: DigestSource, row: RenderRow, env: Env): string {
  const ex = safeParse(row.extra);
  const bits: string[] = [];
  const push = (v: unknown): void => {
    const t = cleanText(s(v));
    if (t) bits.push(t);
  };
  switch (source) {
    case 'gh':
      push(ex.ai_summary);
      break;
    case 'hf-paper': {
      push(ex.summary_zh || ex.ai_summary_zh);
      const d = asObj(ex.deep_analysis);
      if (d) {
        push(d.tldr);
        push(d.problem);
        for (const k of asArr(d.key_insight)) push(k);
      }
      break;
    }
    case 'ph':
      push(ex.ai_summary);
      push(ex.maker_post_translated || ex.maker_post_text);
      break;
    case 'x':
      push(row.content_translated || row.content);
      break;
    case 'news':
      if (ex.show_key) {
        push(ex.ai_summary_zh);
        push(clampSentences(stripHtmlTags(s(ex.shownotes_zh || ex.shownotes)), PODCAST_SHOWNOTES_MAX));
        // 话题脉络 topic+point（LLM 提炼的结构化元信息，非逐字稿）纳入可索引文本增 SEO。
        for (const t of asArr(ex.timeline)) {
          const o = asObj(t);
          if (!o) continue;
          push(o.topic);
          push(o.point);
        }
      } else {
        push(ex.ai_summary_zh);
        push(ex.excerpt_zh || ex.excerpt);
      }
      break;
    default:
      push(row.content_translated || row.content);
  }
  return bits.join(' ').slice(0, INDEXABLE_MAX);
}

// ── 分源渲染器 ─────────────────────────────────────────────────────────────────

// gh：我们的 ai_summary（前置）+ README 全文（译文优先，md→安全 HTML，截 40KB，图片 resolve 到 raw/R2）。
function renderGh(row: RenderRow, ex: Rec, apiBase: string): string {
  const parts: string[] = [];
  const summary = s(ex.ai_summary);
  if (summary) parts.push(lead(summary));

  const readme = s(ex.readme_translated) || s(ex.readme_excerpt);
  if (readme) {
    const owner = ghOwner(row.id);
    const repo = ghRepoName(row.id);
    const branch = s(ex.default_branch) || 'main';
    const rewritten = rewriteReadmeImageUrls(readme, owner, repo, branch, apiBase);
    const { html, truncated } = markdownToSafeHtml(rewritten, { maxChars: GH_README_MAX_CHARS });
    const safe = addLazy(demoteHeadings(html));
    if (safe) parts.push(`<h2>README</h2>\n<div class="item-body">${safe}</div>`);
    if (truncated && row.url) {
      parts.push(extLink(row.url, '在 GitHub 查看完整 README →'));
    }
  }
  return parts.join('\n') || renderFallback(row, ex);
}

// hf：abstract 中译（summary_zh）+ 我们原创的 deep_analysis 7 维拆解。
function renderHf(row: RenderRow, ex: Rec): string {
  const parts: string[] = [];
  const abstract = s(ex.summary_zh) || s(ex.ai_summary_zh) || s(row.content_translated) || s(row.content);
  if (abstract) parts.push(lead(clampSentences(abstract, 1600)));

  const d = asObj(ex.deep_analysis);
  if (d) parts.push(renderDeepAnalysis(d));
  return parts.join('\n') || renderFallback(row, ex);
}

function renderDeepAnalysis(d: Rec): string {
  const out: string[] = ['<h2>论文精读</h2>\n<div class="item-body">'];
  const tldr = s(d.tldr);
  if (tldr) out.push(`<p><strong>TL;DR</strong> ${escapeHtml(tldr)}</p>`);
  const section = (label: string, md: string): void => {
    const body = mdInline(md);
    if (body) out.push(`<h3>${label}</h3>${body}`);
  };
  const listSection = (label: string, arr: unknown[]): void => {
    const lis = arr.map((x) => s(x)).filter(Boolean).map((x) => `<li>${escapeHtml(x)}</li>`);
    if (lis.length) out.push(`<h3>${label}</h3><ul>${lis.join('')}</ul>`);
  };
  section('问题', s(d.problem));
  listSection('核心洞察', asArr(d.key_insight));
  section('方法', s(d.method));
  const exp = asObj(d.experiments);
  if (exp && s(exp.narrative)) section('实验', s(exp.narrative));
  section('行业影响', s(d.industry_impact));
  listSection('局限', asArr(d.limitations));
  out.push('</div>');
  return out.join('');
}

// ph：AI 解读（ai_summary）+ maker post + 热门评论（结构化，每条渲染）。
function renderPh(row: RenderRow, ex: Rec): string {
  const parts: string[] = [];
  const summary = s(ex.ai_summary) || s(row.content_translated) || s(row.content);
  if (summary) parts.push(lead(summary));

  const makerPost = s(ex.maker_post_translated) || s(ex.maker_post_text);
  if (makerPost) parts.push(`<h2>Maker 说</h2>\n<div class="item-body">${plainToHtml(makerPost)}</div>`);

  const comments = asArr(ex.top_comments).map((c) => asObj(c)).filter((c): c is Rec => !!c);
  if (comments.length) {
    const cards = comments.slice(0, PH_COMMENT_MAX).map(renderComment).filter(Boolean);
    if (cards.length) parts.push(`<h2>热门评论</h2>\n<div class="comments">${cards.join('')}</div>`);
  }
  return parts.join('\n') || renderFallback(row, ex);
}

function renderComment(c: Rec): string {
  const author = s(c.author_name) || s(c.author_handle);
  const text = s(c.translated) || s(c.text);
  let body = '';
  if (text) body = `<div class="comment-text">${nl2br(escapeHtml(text))}</div>`;
  else {
    const bh = s(c.body_html);
    if (bh) body = `<div class="comment-text item-body">${addLazy(demoteHeadings(markdownToSafeHtml(bh).html))}</div>`;
  }
  if (!body) return '';
  const head = author ? `<div class="comment-author">${escapeHtml(author)}</div>` : '';
  return `<div class="comment">${head}${body}</div>`;
}

// x：主推 content_translated（推文串，若 extra.thread 有聚合则逐条）+ 引用 quote_of。
// 注：单条 row 无兄弟推文（thread siblings 是独立 items 行），renderItemBody 为纯同步函数，不查 DB；
// 若上游未在 extra.thread 预聚合，则串 = 主推单条（前端 TweetDrawer 才做客户端聚合）。
function renderX(row: RenderRow, ex: Rec): string {
  const parts: string[] = [];
  const mainAuthor = s(row.author) || s(row.handle);
  const cards: string[] = [];

  const thread = asArr(ex.thread).map((t) => asObj(t)).filter((t): t is Rec => !!t);
  if (thread.length) {
    for (const t of thread) {
      const tc = s(t.content_translated) || s(t.content);
      if (tc) cards.push(tweetCard(s(t.author) || s(t.handle) || mainAuthor, tc));
    }
  } else {
    const main = s(row.content_translated) || s(row.content);
    if (main) cards.push(tweetCard(mainAuthor, main));
  }
  if (cards.length) parts.push(`<div class="tweet-thread">${cards.join('')}</div>`);

  const q = asObj(ex.quote_of);
  if (q) {
    const qc = s(q.content_translated) || s(q.content);
    if (qc) {
      const qa = s(q.author) || s(q.handle);
      const head = qa ? `<div class="quote-author">${escapeHtml(qa)}</div>` : '';
      parts.push(`<blockquote class="quote-tweet">${head}<div>${nl2br(escapeHtml(qc))}</div></blockquote>`);
    }
  }
  return parts.join('\n') || renderFallback(row, ex);
}

function tweetCard(author: string, content: string): string {
  const head = author ? `<div class="tweet-author">${escapeHtml(author)}</div>` : '';
  return `<div class="tweet-card">${head}<div class="tweet-text">${nl2br(escapeHtml(content))}</div></div>`;
}

// blog（半文源）：我们的摘要 + 要点 + 正文**短摘录**（首 ~800 字，非全文）+ 显著原文出处链。
function renderBlog(row: RenderRow, ex: Rec): string {
  const parts: string[] = [];
  const summary = s(ex.ai_summary_zh);
  if (summary) parts.push(lead(summary));

  const excerptField = s(ex.excerpt_zh) || s(ex.excerpt);
  if (excerptField && !isPrefixOverlap(summary, excerptField)) {
    parts.push(`<p class="summary">${escapeHtml(clampSentences(excerptField, BLOG_ANALYSIS_MAX))}</p>`);
  }

  // 正文摘录：仅首 ~800 字（clampSentences 已 strip markdown + 收尾按句），**绝不**渲染 body_markdown_zh 全文。
  const bodyMd = s(ex.body_markdown_zh) || s(ex.body_markdown);
  if (bodyMd) {
    const excerpt = clampSentences(stripHtmlTags(bodyMd), BLOG_EXCERPT_MAX);
    if (excerpt) parts.push(`<h2>正文摘录</h2>\n<blockquote class="excerpt">${escapeHtml(excerpt)}</blockquote>`);
  }
  parts.push(readOriginal(row, ex));
  return parts.filter(Boolean).join('\n');
}

// podcast（半文源）：我们的摘要 + 嘉宾/主持 + 章节/时间轴（时间戳 + 说话人 + 核心观点）+ 节目简介**短摘录**。
// 绝不渲染 transcript 全文（版权边界）。timeline 的 topic/point/speaker 均为 LLM 提炼的结构化元信息，非逐字稿原文。
function renderPodcast(row: RenderRow, ex: Rec): string {
  const parts: string[] = [];
  const summary = s(ex.ai_summary_zh);
  if (summary) parts.push(lead(summary));

  // 嘉宾/主持：结构化元信息（人名纯文本，非逐字稿）。对齐抽屉——guests 对 hosts 去重。
  const people = renderPodcastPeople(ex);
  if (people) parts.push(people);

  const chapters = asArr(ex.chapters).map((c) => asObj(c)).filter((c): c is Rec => !!c);
  if (chapters.length) {
    const lis = chapters
      .map((c) => {
        const title = s(c.title);
        return title ? `<li><span class="ts">${formatTs(Number(c.start_sec) || 0)}</span> ${escapeHtml(title)}</li>` : '';
      })
      .filter(Boolean);
    if (lis.length) parts.push(`<h2>章节</h2>\n<ul class="chapters">${lis.join('')}</ul>`);
  } else {
    // 无原生章节时退回时间轴主题脉络（A 档）。每节点：ts + topic + speaker（有则）+ point（核心观点，有则）。
    const timeline = asArr(ex.timeline).map((t) => asObj(t)).filter((t): t is Rec => !!t);
    if (timeline.length) {
      const lis = timeline.map(renderTimelineNode).filter(Boolean);
      if (lis.length) parts.push(`<h2>话题脉络</h2>\n<ul class="chapters timeline">${lis.join('')}</ul>`);
    }
  }

  // 节目简介：shownotes 短摘录（strip HTML → 按句 clamp 800）。绝不渲染 transcript_text/_zh 全文。
  const shownotes = s(ex.shownotes_zh) || s(ex.shownotes);
  if (shownotes) {
    const excerpt = clampSentences(stripHtmlTags(shownotes), PODCAST_SHOWNOTES_MAX);
    if (excerpt) parts.push(`<h2>节目简介</h2>\n<blockquote class="excerpt">${escapeHtml(excerpt)}</blockquote>`);
  }
  parts.push(readOriginal(row, ex));
  return parts.filter(Boolean).join('\n');
}

// 嘉宾/主持区（结构化人名，纯文本 escapeHtml）。guests 对 hosts 大小写不敏感去重（对齐抽屉显示层兜底）。
// 数据全无 → 空串（优雅降级，不渲染该区）。
function renderPodcastPeople(ex: Rec): string {
  const hosts = names(ex.hosts);
  const hostLower = new Set(hosts.map((h) => h.toLowerCase()));
  const guests = names(ex.guests).filter((g) => !hostLower.has(g.toLowerCase()));
  const rows: string[] = [];
  if (hosts.length) rows.push(`<p><span class="people-label">主持</span>${escapeHtml(hosts.join('、'))}</p>`);
  if (guests.length) rows.push(`<p><span class="people-label">嘉宾</span>${escapeHtml(guests.join('、'))}</p>`);
  return rows.length ? `<div class="podcast-people">${rows.join('')}</div>` : '';
}

// 话题脉络单节点：ts + topic + point（核心观点，最有信息量，有则渲染）+ speaker（说话人，有则）。topic 缺则丢弃整节点。
function renderTimelineNode(t: Rec): string {
  const topic = s(t.topic).trim();
  if (!topic) return '';
  const head = `<span class="ts">${escapeHtml(s(t.ts))}</span><span class="tl-topic">${escapeHtml(topic)}</span>`;
  const point = cleanText(s(t.point));
  const speaker = s(t.speaker).trim();
  const pointHtml = point ? `<p class="tl-point">${escapeHtml(point)}</p>` : '';
  const speakerHtml = speaker ? `<div class="tl-speaker">${escapeHtml(speaker)}</div>` : '';
  return `<li>${head}${pointHtml}${speakerHtml}</li>`;
}

// 优雅降级：源专属字段缺失时，回退到「一句话/加长摘要」纯文本段（对齐升级前行为）。
function renderFallback(row: RenderRow, ex: Rec): string {
  const summary =
    s(row.content_translated) ||
    s(row.content) ||
    s(ex.ai_summary) ||
    s(ex.ai_summary_zh) ||
    s(ex.summary_zh) ||
    s(ex.excerpt_zh);
  return summary ? lead(clampSentences(summary, 800)) : '';
}

// ── 正文骨架 CSS（item-page.ts 以 <style> 内联；仅 /i/ 页用，daily-page PAGE_STYLE 不受影响）─────
export const ITEM_BODY_STYLE = `
.summary-full{color:var(--body);font-size:15px;line-height:1.8;margin:10px 0}
.item-body{color:var(--body);font-size:15px;line-height:1.85;margin:8px 0}
.item-body h2,.item-body h3,.item-body h4,.item-body h5,.item-body h6{border-left:none;padding-left:0;color:var(--text);margin:18px 0 8px;line-height:1.4}
.item-body h3{font-size:16px}.item-body h4,.item-body h5,.item-body h6{font-size:15px}
.item-body p{margin:9px 0}
.item-body ul,.item-body ol{margin:8px 0;padding-left:22px}
.item-body li{margin:4px 0}
.item-body img{max-width:100%;height:auto;border-radius:6px;margin:10px 0;border:1px solid var(--border)}
.item-body pre{background:#f5f5f5;padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6}
.item-body code{background:#f5f5f5;padding:1px 5px;border-radius:4px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.item-body pre code{background:none;padding:0}
.item-body blockquote{margin:10px 0;padding:2px 14px;border-left:3px solid var(--border);color:var(--sub)}
.item-body table{border-collapse:collapse;font-size:13px;margin:10px 0;display:block;overflow-x:auto;max-width:100%}
.item-body th,.item-body td{border:1px solid var(--border);padding:6px 10px;text-align:left}
.tweet-thread{margin:10px 0}
.tweet-card{border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:8px 0;background:var(--card)}
.tweet-author{font-weight:600;color:var(--text);font-size:14px;margin-bottom:4px}
.tweet-text{color:var(--body);font-size:15px;line-height:1.7}
.quote-tweet{border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin:8px 0;color:var(--sub);font-size:14px}
.quote-author{font-weight:600;color:var(--body);margin-bottom:2px}
.comments{margin:6px 0}
.comment{border-top:1px solid var(--border);padding:10px 0}
.comment-author{font-weight:600;font-size:14px;color:var(--text);margin-bottom:3px}
.comment-text{color:var(--body);font-size:14px;line-height:1.7}
.chapters{list-style:none;padding-left:0}
.chapters li{margin:5px 0;color:var(--body);font-size:14px}
.chapters .ts{display:inline-block;min-width:56px;color:var(--link);font-variant-numeric:tabular-nums;font-weight:600}
.timeline li{margin:0 0 12px}
.timeline .tl-topic{font-weight:600;color:var(--text)}
.timeline .tl-point{margin:4px 0 0;color:var(--sub);font-size:14px;line-height:1.7}
.timeline .tl-speaker{margin-top:2px;color:var(--sub);font-size:13px}
.podcast-people{margin:8px 0;font-size:14px;color:var(--body)}
.podcast-people p{margin:3px 0}
.podcast-people .people-label{color:var(--sub);font-weight:600;margin-right:8px}
.excerpt{margin:10px 0;padding:10px 14px;border-left:3px solid var(--border);color:var(--body);font-size:14px;line-height:1.85;white-space:pre-wrap}
.read-original{margin:18px 0 4px;font-size:15px;font-weight:600}
.read-original a{color:var(--link)}
`.trim();

// ── 低层工具 ───────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function safeParse(v: string | null): Rec {
  try {
    return JSON.parse(v || '{}') as Rec;
  } catch {
    return {};
  }
}

/** 仅接受字符串值（对象 / 数字 / null 一律空串），避免把结构化字段误当文本渲染。 */
function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asObj(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 字符串数组字段 → 去空白的非空字符串列表（嘉宾 / 主持等人名数组）。 */
function names(v: unknown): string[] {
  return asArr(v)
    .map((x) => s(x).trim())
    .filter(Boolean);
}

/** 我们的摘要 / 引导段（纯文本，转义后落页）。 */
function lead(text: string): string {
  const t = cleanText(text);
  return t ? `<p class="summary-full">${escapeHtml(t)}</p>` : '';
}

/** 外链（原文出处）：新窗口 + noopener nofollow（第三方，避免权重传导 / 反向 tabnabbing）。 */
function extLink(url: string, label: string): string {
  return `<p class="read-original"><a href="${escapeHtml(url)}" target="_blank" rel="noopener nofollow">${escapeHtml(label)}</a></p>`;
}

/** 半文源显著「阅读原文」出处链：优先展示域名署名。 */
function readOriginal(row: RenderRow, ex: Rec): string {
  if (!row.url) return '';
  const pub = asObj(ex.publisher);
  const domain = domainOf(row.url) || s(ex.source_company) || (pub ? s(pub.name) : '');
  return extLink(row.url, domain ? `阅读原文（${domain}）→` : '阅读原文 →');
}

/** 短 markdown 片段 → 安全 HTML（净化 + 降标题 + 图片补 lazy）；用于 deep_analysis 各维 / 评论 body_html。 */
function mdInline(md: string): string {
  if (!md) return '';
  return addLazy(demoteHeadings(markdownToSafeHtml(md).html));
}

/** 纯文本 → 段落 HTML（双换行分段，单换行 <br>）；用于 maker post 等多段纯文本。 */
function plainToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((par) => par.trim())
    .filter(Boolean)
    .map((par) => `<p>${nl2br(escapeHtml(par))}</p>`)
    .join('');
}

function nl2br(escaped: string): string {
  return escaped.replace(/\n/g, '<br>');
}

/** 标题降一级（h1→h2…h5→h6，h6 保持），保证页面 h1 唯一（页头标题独占）。 */
function demoteHeadings(html: string): string {
  return html.replace(/<(\/?)h([1-5])(\b[^>]*)>/gi, (_m, slash: string, n: string, rest: string) => `<${slash}h${Number(n) + 1}${rest}>`);
}

/** 给净化后 HTML 的 <img> 注入 loading="lazy"（净化白名单不含 loading 属性，故此处补）。 */
function addLazy(html: string): string {
  return html.replace(/<img\b/gi, '<img loading="lazy"');
}

/** 剥除 HTML 标签（shownotes 中文源为 HTML；摘录前先转纯文本再按句 clamp）。 */
function stripHtmlTags(str: string): string {
  return str
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1].replace(/^www\./i, '') : '';
}

/** 时长秒 → mm:ss / h:mm:ss。 */
function formatTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 规范化后判两段是否同源前缀（避免摘要与要点逐字重复渲染）。 */
function isPrefixOverlap(a: string, b: string): boolean {
  const norm = (x: string): string => cleanText(x).replace(/…+$/, '').trim();
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
}

// composite id owner/repo 抽取（对齐 render.ts 私有实现，本模块自持避免耦合 renderItem 内部）。
function ghOwner(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  return sid.split('/')[0] || '';
}

function ghRepoName(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  const slash = sid.lastIndexOf('/');
  return slash >= 0 ? sid.slice(slash + 1) : sid;
}

// README markdown 图片 URL → 绝对地址（相对→raw.githubusercontent，/r/→apiBase，http(s)/data 透传）。
// 净化层 img[src] 只放行 http(s)，相对路径会被剥 → 故渲染前先重写为绝对。与 render.ts resolveReadmeImages
// 同口径 resolve（但此处不做 badge 过滤：badge 多为绝对 URL，原样透传即可）。
function rewriteReadmeImageUrls(readme: string, owner: string, repo: string, branch: string, apiBase: string): string {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}`;
  const resolve = (u: string): string => {
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.startsWith('/r/')) return `${apiBase}${u}`;
    return u.startsWith('/') ? `${base}${u}` : `${base}/${u.replace(/^\.\//, '')}`;
  };
  let out = readme.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (_m, pre: string, u: string) => pre + resolve(u));
  out = out.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (_m, pre: string, u: string, post: string) => pre + resolve(u) + post);
  return out;
}

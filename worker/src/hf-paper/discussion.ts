// Step 1 helper:fetch-discussion(svelte_ssr 解析,Phase 0.5 验证)
// Step 2 helper:translate-discussion-comments(flash 批量)
//
// HF paper web page 用 Svelte SSR,所有数据(含 comments)直接通过
//   <div class="SVELTE_HYDRATER contents" data-target="PaperContent" data-props="...">
// 嵌入 HTML。fetch + regex + HTML decode + JSON parse → comments[]
//
// Phase 0.5 reconnaissance 报告:
//   docs/plans/_research/2026-05-18-hf-discussion-internal-data-recon.md

import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_FLASH } from './llm';
import { buildCommentsTranslatePrompt } from './prompts';

const HF_PAPER_URL_BASE = 'https://huggingface.co/papers';
const SSR_PROPS_RE = /<div class="SVELTE_HYDRATER contents" data-target="PaperContent" data-props="([^"]*)"/;

// ────────────────────────────────────────────────────────────────────
// fetch-discussion(svelte_ssr)
// ────────────────────────────────────────────────────────────────────

interface HfCommentRaw {
  id: string;
  author: {
    _id: string;
    avatarUrl?: string;
    fullname?: string;
    name?: string;
    type?: string;
    isPro?: boolean;
    isHfAdmin?: boolean;
  };
  createdAt: string;
  type: string;
  data?: {
    edited?: boolean;
    hidden?: boolean;
    latest?: {
      raw?: string;
      html?: string;
      updatedAt?: string;
    };
    numEdits?: number;
    identifiedLanguage?: { language?: string; probability?: number };
    reactions?: Array<{ reaction: string; users?: string[]; count: number }>;
    isReport?: boolean;
  };
}

interface HfPaperPageProps {
  paper?: {
    submittedOnDailyBy?: { _id?: string };
  };
  comments?: HfCommentRaw[];
}

// 写入 extra.discussion_comments 的字段(跟设计文档 §3.2 一致)
interface HfCommentNormalized {
  id: string;
  author_name: string;
  author_handle: string;
  raw_author_avatar_url: string | null;
  author_avatar_url: string | null;       // R2 迁移后由 backfill-media-r2 改成 /r/hf/<sha>
  is_pro: boolean;
  is_hf_admin: boolean;
  content: string;
  content_html: string;
  content_zh: string | null;              // translate-discussion-comments 后填
  posted_at: string;
  updated_at: string | null;
  edited: boolean;
  is_author_reply: boolean;               // 推算
  language: string | null;
  reactions: Array<{ emoji: string; count: number }>;
  like_count: number;
}

export async function fetchDiscussionForHfPaper(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<{ fetched: boolean; comments_count: number; reason?: string }> {
  // 1. fetch web page(匿名 + UA)
  let html: string | null = null;
  try {
    const r = await fetch(`${HF_PAPER_URL_BASE}/${arxivId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
    });
    if (!r.ok) {
      console.warn(`[hf-paper:discussion] ${arxivId} HTTP ${r.status}`);
      return { fetched: false, comments_count: 0, reason: `http_${r.status}` };
    }
    html = await r.text();
  } catch (e) {
    console.error(`[hf-paper:discussion] ${arxivId} fetch exception`, e);
    return { fetched: false, comments_count: 0, reason: 'fetch_exception' };
  }

  // 2. regex 提 PaperContent data-props
  const m = html.match(SSR_PROPS_RE);
  if (!m) {
    console.warn(`[hf-paper:discussion] ${arxivId} PaperContent data-props 未匹配(HF 改版?)`);
    return { fetched: false, comments_count: 0, reason: 'props_not_found' };
  }

  // 3. HTML decode + JSON parse
  let props: HfPaperPageProps;
  try {
    props = JSON.parse(htmlUnescape(m[1])) as HfPaperPageProps;
  } catch (e) {
    console.error(`[hf-paper:discussion] ${arxivId} data-props JSON parse fail`, e);
    return { fetched: false, comments_count: 0, reason: 'json_parse_fail' };
  }

  const rawComments = props.comments || [];
  const paperSubmitterId = props.paper?.submittedOnDailyBy?._id;

  // 4. normalize:推算 is_author_reply,简化 reactions(去 users[]),提 👍 count
  const normalized: HfCommentNormalized[] = rawComments.map((c) => {
    const author = c.author;
    const data = c.data || {};
    const latest = data.latest || {};
    const isAuthorReply = !!paperSubmitterId && author._id === paperSubmitterId;
    const reactions = (data.reactions || []).map((r) => ({
      emoji: r.reaction,
      count: r.count,
    }));
    const likeReaction = (data.reactions || []).find((r) => r.reaction === '👍');
    return {
      id: c.id,
      author_name: author.fullname || author.name || '',
      author_handle: author.name || '',
      raw_author_avatar_url: author.avatarUrl || null,
      author_avatar_url: author.avatarUrl || null,    // R2 迁移后改成 /r/hf/<sha>
      is_pro: author.isPro || false,
      is_hf_admin: author.isHfAdmin || false,
      content: latest.raw || '',
      content_html: latest.html || '',
      content_zh: null,                                // step 2 翻译后填
      posted_at: c.createdAt,
      updated_at: latest.updatedAt || null,
      edited: data.edited || false,
      is_author_reply: isAuthorReply,
      language: data.identifiedLanguage?.language || null,
      reactions,
      like_count: likeReaction?.count || 0,
    };
  });

  // 5. 写回 extra.discussion_comments + discussion_fetched_at + discussion_fetch_method
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(coalesce(extra, '{}'),
      '$.discussion_comments', json(?),
      '$.discussion_fetched_at', ?,
      '$.discussion_fetch_method', 'svelte_ssr')
      WHERE id = ?`,
  ).bind(JSON.stringify(normalized), new Date().toISOString(), itemId).run();

  return { fetched: true, comments_count: normalized.length };
}

/**
 * HTML decode for SVG/HTML attribute values(常见实体 + numeric)
 *
 * data-props 是 HTML attribute value,值含 &quot; / &amp; / &lt; / &gt; / &#39;
 * JSON parse 之前要 decode 这些。
 */
function htmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&'); // 最后处理,防 double-decode
}

// ────────────────────────────────────────────────────────────────────
// translate-discussion-comments(flash 批量)
// ────────────────────────────────────────────────────────────────────

interface ItemDiscussionRow {
  title: string | null;
  extra: string | null;
}

export async function translateDiscussionCommentsForHfPaper(
  env: Env,
  itemId: string,
): Promise<{ translated: number; skipped: number; reason?: string }> {
  if (!env.DEEPSEEK_API_KEY) {
    return { translated: 0, skipped: 0, reason: 'no_deepseek_key' };
  }
  const row = await env.DB.prepare(
    `SELECT title, extra FROM items WHERE id = ?`,
  ).bind(itemId).first<ItemDiscussionRow>();
  if (!row?.extra) return { translated: 0, skipped: 0, reason: 'no_extra' };

  const extra = JSON.parse(row.extra) as { discussion_comments?: HfCommentNormalized[] };
  const comments = extra.discussion_comments || [];
  if (comments.length === 0) return { translated: 0, skipped: 0, reason: 'no_comments' };

  // 只翻 content_zh IS NULL 且 content 非空 的(zh 评论也翻一遍,prompt 里指示 zh 输出原文)
  const toTranslate = comments.filter((c) => c.content_zh === null && c.content.length > 0);
  if (toTranslate.length === 0) return { translated: 0, skipped: 0, reason: 'all_translated' };

  // Batch 10 条/次
  let translated = 0;
  for (let i = 0; i < toTranslate.length; i += 10) {
    const batch = toTranslate.slice(i, i + 10);
    const prompt = buildCommentsTranslatePrompt({
      paper_title: row.title || '',
      comments: batch.map((c) => ({ id: c.id, author: c.author_name, content: c.content })),
    });
    const result = await callDeepSeekJson<{ translations?: Array<{ id: string; content_zh: string }> }>(
      env.DEEPSEEK_API_KEY,
      DEEPSEEK_FLASH,
      prompt,
      { maxTokens: 4000, timeoutMs: 90_000 },
    );
    if (!result.data?.translations) {
      console.warn(`[hf-paper:translate-comments] batch ${i} parse fail`);
      continue;
    }
    const trMap = new Map(result.data.translations.map((t) => [t.id, t.content_zh]));
    for (const c of batch) {
      const zh = trMap.get(c.id);
      if (zh) {
        c.content_zh = zh;
        translated++;
      }
    }
  }

  // 写回
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.discussion_comments', json(?)) WHERE id = ?`,
  ).bind(JSON.stringify(comments), itemId).run();

  console.log(`[hf-paper:translate-comments] ${itemId} translated=${translated}/${toTranslate.length}`);
  return { translated, skipped: comments.length - translated };
}

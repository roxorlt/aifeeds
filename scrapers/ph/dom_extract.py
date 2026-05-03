"""DOM 抓取（评论 / reviews / maker post）— 通过 browser-use eval JS 跑。

JSON-LD 拿不到 launch 评论 / reviews body，必须从渲染后的 DOM 抓。

PH selector 速查（Zed 页样本观察）:
  comment block:  [data-test^="comment-"] (e.g. comment-5335621)
  comment thread: [data-test^="thread-"]   (一个 thread = 一个 top-level comment)
  comment author: [data-test^="user-image-link-"] inside comment, href=/@handle
  comment body:   .prose.styles-module__3C9wzW__richText (rich text container)
  review block:   [data-test^="detailed-review-"]
  vote button:    [data-test="action-bar-vote-button"]

maker 识别：用 makers[].handle 反查（PH 不打 maker badge 在评论上，
我们自己根据 author handle ∈ makers[].handle 推断）。
"""
from __future__ import annotations


# Top-level comments only —— 按 [data-test^="thread-"] 容器分组，每个 thread
# 取第一个 comment 节点作为 top-level（其余是回复，先丢掉）。
# 旧实现抓所有 [data-test^="comment-"] 把回复也算进去了，导致同作者刷屏
# （schole-2 vinitra × 5 即此 bug 的实例）。
EXTRACT_COMMENTS_JS = r"""
(function() {
  const out = [];
  const processed = new Set();

  function parseCommentNode(el, id) {
    let authorHandle = '';
    let authorName = '';
    const allUserLinks = el.querySelectorAll('a[href*="/@"]');
    for (const a of allUserLinks) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/@([\w-]+)/);
      if (m && !authorHandle) authorHandle = m[1];
      const txt = (a.textContent || '').trim();
      if (txt && !authorName) authorName = txt;
      if (authorHandle && authorName) break;
    }

    let avatarUrl = '';
    const avatarImg = el.querySelector('img[src*="ph-avatars.imgix.net"], img[srcset*="ph-avatars.imgix.net"]');
    if (avatarImg) {
      const srcset = avatarImg.getAttribute('srcset') || '';
      const src = avatarImg.getAttribute('src') || '';
      const oneX = srcset.split(',').map(s => s.trim()).find(s => s.endsWith(' 1x'));
      avatarUrl = oneX ? oneX.split(' ')[0] : src;
    }

    let body = '';
    const richText = el.querySelector('.prose');
    if (richText) {
      body = (richText.innerText || richText.textContent || '').trim();
    }

    let upvotes = null;
    const voteBtn = el.querySelector('[data-test="action-bar-vote-button"]');
    if (voteBtn) {
      const txt = voteBtn.parentElement ? voteBtn.parentElement.innerText.trim() : '';
      const m = txt.match(/(\d[\d,]*)/);
      upvotes = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    }

    let postedAt = '';
    const timeEl = el.querySelector('time[datetime]');
    if (timeEl) postedAt = timeEl.getAttribute('datetime') || '';

    return {
      id,
      author_name: authorName,
      author_handle: authorHandle,
      avatar_url: avatarUrl,
      body,
      upvotes,
      posted_at: postedAt,
      is_reply: false,
    };
  }

  // Step 1: 按 thread 容器拿 top-level comment（每个 thread 第一个 comment 节点）
  const threads = document.querySelectorAll('[data-test^="thread-"]');
  threads.forEach((thread) => {
    try {
      const firstComment = thread.querySelector('[data-test]');
      if (!firstComment) return;
      // 挖到第一个真 comment 节点（thread 容器自己 data-test 是 thread-xxx，
      // 容器内第一个 [data-test=comment-N] 才是 top-level）
      const candidates = thread.querySelectorAll('[data-test]');
      let topComment = null;
      for (const c of candidates) {
        const idAttr = c.getAttribute('data-test') || '';
        if (/^comment-\d+$/.test(idAttr)) {
          topComment = c;
          break;
        }
      }
      if (!topComment) return;
      const idMatch = topComment.getAttribute('data-test').match(/^comment-(\d+)$/);
      if (!idMatch) return;
      const id = idMatch[1];
      if (processed.has(id)) return;
      processed.add(id);
      const parsed = parseCommentNode(topComment, id);
      if (parsed && (parsed.body || parsed.author_handle)) out.push(parsed);
    } catch (e) {}
  });

  // Step 2: 兜底——若没找到 thread 容器（PH 改版），扫所有 comment 节点，
  // 按 DOM 嵌套排除回复（祖先里若有另一个 comment-N 节点 → 是回复，跳过）
  if (out.length === 0) {
    document.querySelectorAll('[data-test]').forEach((el) => {
      try {
        const idAttr = el.getAttribute('data-test') || '';
        const idMatch = idAttr.match(/^comment-(\d+)$/);
        if (!idMatch) return;
        const id = idMatch[1];
        if (processed.has(id)) return;
        // 祖先链里是否已经有另一个 comment 节点 → 是回复
        let p = el.parentElement;
        let nested = false;
        while (p && p !== document.body) {
          const a = p.getAttribute && p.getAttribute('data-test');
          if (a && /^comment-\d+$/.test(a)) { nested = true; break; }
          p = p.parentElement;
        }
        if (nested) return;
        processed.add(id);
        const parsed = parseCommentNode(el, id);
        if (parsed && (parsed.body || parsed.author_handle)) out.push(parsed);
      } catch (e) {}
    });
  }

  return JSON.stringify(out);
})()
"""


# Reviews — 类似 comments 但 selector 不同
EXTRACT_REVIEWS_JS = r"""
(function() {
  const out = [];
  // detailed-review-<id> 是 review 的 actionbar，review body 容器是上层
  // 拿所有 detailed-review-<id> 的父容器（review root）
  const seen = new Set();
  const actionbars = document.querySelectorAll('[data-test^="detailed-review-"][data-test$="-actionbar"]');
  actionbars.forEach((bar) => {
    try {
      const idAttr = bar.getAttribute('data-test') || '';
      const m = idAttr.match(/detailed-review-(\d+)-actionbar/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      // Walk up to review container (heuristic: parent that contains both rating + body)
      let root = bar.parentElement;
      for (let i = 0; i < 5 && root; i++) {
        if (root.querySelector('a[href*="/@"]') && (root.innerText || '').match(/\d\s*(out of|\/)\s*5/i)) break;
        root = root.parentElement;
      }
      if (!root) return;

      let authorName = '';
      let authorHandle = '';
      const authorLink = root.querySelector('a[href*="/@"]');
      if (authorLink) {
        authorName = (authorLink.textContent || '').trim();
        const hm = authorLink.getAttribute('href').match(/\/@([\w-]+)/);
        authorHandle = hm ? hm[1] : '';
      }

      let avatarUrl = '';
      const ai = root.querySelector('img[src*="ph-avatars.imgix.net"], img[srcset*="ph-avatars.imgix.net"]');
      if (ai) avatarUrl = ai.getAttribute('src') || '';

      // rating — count filled stars or extract from text
      let rating = null;
      const ratingText = (root.innerText || '').match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5/i);
      if (ratingText) rating = parseFloat(ratingText[1]);

      // body — biggest text block (heuristic)
      let body = '';
      const blocks = root.querySelectorAll('p, div.prose, [class*="richText"]');
      let longest = '';
      blocks.forEach((b) => {
        const t = (b.innerText || '').trim();
        if (t.length > longest.length && t.length < 5000) longest = t;
      });
      body = longest;

      out.push({
        id,
        author_name: authorName,
        author_handle: authorHandle,
        avatar_url: avatarUrl,
        rating,
        body,
      });
    } catch (e) {
      // skip
    }
  });
  return JSON.stringify(out);
})()
"""

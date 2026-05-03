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


# Maker post / Top comments / Replies — 一次 eval 拿全部
EXTRACT_COMMENTS_JS = r"""
(function() {
  const out = [];
  const blocks = document.querySelectorAll('[data-test^="comment-"]');
  blocks.forEach((el) => {
    try {
      const idAttr = el.getAttribute('data-test') || '';
      const id = idAttr.replace('comment-', '');

      // author handle from any /@<handle> link inside
      let authorHandle = '';
      let authorName = '';
      const authorLink = el.querySelector('a[href*="/@"]');
      if (authorLink) {
        const m = authorLink.getAttribute('href').match(/\/@([\w-]+)/);
        authorHandle = m ? m[1] : '';
        authorName = (authorLink.textContent || '').trim();
      }

      // avatar
      let avatarUrl = '';
      const avatarImg = el.querySelector('img[src*="ph-avatars.imgix.net"], img[srcset*="ph-avatars.imgix.net"]');
      if (avatarImg) {
        const srcset = avatarImg.getAttribute('srcset') || '';
        const src = avatarImg.getAttribute('src') || '';
        // 优先 srcset 1x（最清晰且非 base path）
        const oneX = srcset.split(',').map(s => s.trim()).find(s => s.endsWith(' 1x'));
        avatarUrl = oneX ? oneX.split(' ')[0] : src;
      }

      // body — 'prose' richText container
      let body = '';
      const richText = el.querySelector('.prose');
      if (richText) {
        body = (richText.innerText || richText.textContent || '').trim();
      }

      // upvotes — inside this comment's action-bar-vote-button
      let upvotes = null;
      const voteBtn = el.querySelector('[data-test="action-bar-vote-button"]');
      if (voteBtn) {
        // Number is usually adjacent text node or sibling span
        const txt = voteBtn.parentElement ? voteBtn.parentElement.innerText.trim() : '';
        const m = txt.match(/(\d[\d,]*)/);
        upvotes = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
      }

      // posted_at — try [data-test*="time"] or <time> tag near
      let postedAt = '';
      const timeEl = el.querySelector('time[datetime]');
      if (timeEl) postedAt = timeEl.getAttribute('datetime') || '';

      // detect reply / nesting level via container offset (PH uses CSS for nesting,
      // not data-attr). Heuristic: if the comment is wrapped in a div with
      // padding-left > 16px indicating a reply.
      let isReply = false;
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const cls = parent.className || '';
        if (typeof cls === 'string' && /pl-\d|ml-\d/.test(cls) && /comment-/.test(parent.outerHTML.slice(0, 200))) {
          isReply = true;
          break;
        }
        parent = parent.parentElement;
      }

      out.push({
        id,
        author_name: authorName,
        author_handle: authorHandle,
        avatar_url: avatarUrl,
        body,
        upvotes,
        posted_at: postedAt,
        is_reply: isReply,
      });
    } catch (e) {
      // skip individual failure
    }
  });
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

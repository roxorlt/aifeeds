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

  // Step 1: 按 thread 容器拿 top-level comment。
  // PH 把 *每条* comment（含 reply）都包在 [data-test^="thread-"] 里，
  // 区别在于 reply 的 thread-N 嵌套在父 thread-M 里。所以必须只处理
  // 真正顶层的 thread（祖先里没有别的 thread-X）。
  // PH 约定：thread-N 的顶层 comment 节点 data-test == comment-N（同 ID）。
  // 同一 thread DOM 在 mobile / desktop 双渲染会出现两次，按 thread-N
  // 去重。
  const threads = document.querySelectorAll('[data-test^="thread-"]');
  threads.forEach((thread) => {
    try {
      const threadIdAttr = thread.getAttribute('data-test') || '';
      const threadMatch = threadIdAttr.match(/^thread-(\d+)$/);
      if (!threadMatch) return;
      const threadId = threadMatch[1];

      // 嵌套检查：祖先链里是否有别的 thread-X → 是 reply，跳过
      let p = thread.parentElement;
      let nested = false;
      while (p && p !== document.body) {
        const a = p.getAttribute && p.getAttribute('data-test');
        if (a && /^thread-\d+$/.test(a)) { nested = true; break; }
        p = p.parentElement;
      }
      if (nested) return;

      if (processed.has(threadId)) return;
      processed.add(threadId);

      // 用 PH 约定：thread-N 的顶层 comment 直接是 comment-N
      const topComment = thread.querySelector('[data-test="comment-' + threadId + '"]');
      if (!topComment) return;
      const parsed = parseCommentNode(topComment, threadId);
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


# Reviews — 用 detailed-review-<id>-actionbar 定位每条 review 的 actionbar，
# 然后向上找该 review 的 root 容器。
#
# 老 bug：原来要求 root 同时包含 @-link 和 "X out of 5" 文本，但 PH 用星标
# icon 不写文本，rating 永远找不到 → 走到 5 层外的公共父级，3 条不同 review
# 都拿到同一个 body（manus Orion Zou × 3 即此 bug）。
#
# 新策略：向上走直到下一层祖先含多个不同 handle，停在前一层（即包含恰好
# 1 个 handle 的最深祖先 = 该 review 的 root）。
EXTRACT_REVIEWS_JS = r"""
(function() {
  const out = [];
  const seen = new Set();
  const actionbars = document.querySelectorAll('[data-test^="detailed-review-"][data-test$="-actionbar"]');

  function collectHandles(el) {
    const links = el.querySelectorAll('a[href*="/@"]');
    const handles = new Set();
    for (const a of links) {
      const m = (a.getAttribute('href') || '').match(/\/@([\w-]+)/);
      if (m) handles.add(m[1]);
    }
    return handles;
  }

  actionbars.forEach((bar) => {
    try {
      const idAttr = bar.getAttribute('data-test') || '';
      const m = idAttr.match(/^detailed-review-(\d+)-actionbar$/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;  // mobile/desktop 双渲染去重

      // 向上找该 review 的 root：祖先里有别的 handle 加入就停
      let root = bar.parentElement;
      let bestRoot = null;
      for (let i = 0; i < 12 && root; i++) {
        const handles = collectHandles(root);
        if (handles.size > 1) break;        // 已混入别的 review → 上一层是边界
        if (handles.size === 1) bestRoot = root;
        root = root.parentElement;
      }
      if (!bestRoot) return;
      seen.add(id);

      let authorName = '';
      let authorHandle = '';
      const authorLink = bestRoot.querySelector('a[href*="/@"]');
      if (authorLink) {
        authorName = (authorLink.textContent || '').trim();
        const hm = authorLink.getAttribute('href').match(/\/@([\w-]+)/);
        authorHandle = hm ? hm[1] : '';
      }

      let avatarUrl = '';
      const ai = bestRoot.querySelector('img[src*="ph-avatars.imgix.net"], img[srcset*="ph-avatars.imgix.net"]');
      if (ai) {
        const srcset = ai.getAttribute('srcset') || '';
        const src = ai.getAttribute('src') || '';
        const oneX = srcset.split(',').map(s => s.trim()).find(s => s.endsWith(' 1x'));
        avatarUrl = oneX ? oneX.split(' ')[0] : src;
      }

      // rating — 优先 ARIA / 星标数；fallback 文本匹配
      let rating = null;
      const ratingText = (bestRoot.innerText || '').match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5/i);
      if (ratingText) {
        rating = parseFloat(ratingText[1]);
      } else {
        // 数 SVG / [aria-label*="star"] 之类的填充星标
        const filledStars = bestRoot.querySelectorAll('svg[fill][class*="text-amber"], svg[class*="filled"], [aria-label*="star" i][aria-label*="filled" i]').length;
        if (filledStars > 0 && filledStars <= 5) rating = filledStars;
      }

      // body — 最大文本块（prose / richText / 长 p）
      let body = '';
      const blocks = bestRoot.querySelectorAll('p, div.prose, [class*="richText"]');
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
    } catch (e) {}
  });
  return JSON.stringify(out);
})()
"""

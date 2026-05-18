# Phase 0.5 报告:HF discussion 抓取路径 reconnaissance

> 日期:2026-05-18
> Phase 0.5(0.5 天)结论:**走 paper web page SSR data-props 解析**,**不需要 puppeteer 也不需要 internal API token**
> 工时影响:总工时 12.75 天 → **11.75 天**(乐观值实现)
> OPS 影响:**#2 CF Browser Rendering verify 项不需要做了**

---

## 1. TL;DR

HF paper web page(`https://huggingface.co/papers/{arxiv_id}`)用 Svelte SSR,**整个页面数据(paper + comments + upvoters 等)直接通过 `data-props` HTML attribute 嵌入到 `<div data-target="PaperContent">` 元素**。匿名 fetch 即可,Python `re + html.unescape + json.loads` 三步解析出完整 JSON。

实现路径:

```typescript
// worker/src/hf-paper/fetch-discussion.ts(预期实现)
async function fetchDiscussionForHfPaper(env, itemId, arxivId) {
  const resp = await fetch(`https://huggingface.co/papers/${arxivId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const html_text = await resp.text();

  // 正则提取 PaperContent data-props
  const m = html_text.match(
    /<div class="SVELTE_HYDRATER contents" data-target="PaperContent" data-props="([^"]*)"/,
  );
  if (!m) return { fetched: false, comments_count: 0 };

  // HTML decode + JSON parse
  const props = JSON.parse(htmlUnescape(m[1]));
  const comments = props.comments || [];

  // 映射到 extra.discussion_comments 结构(§3.2 更新)+ R2 迁移 avatar
  // ...
  return { fetched: true, comments_count: comments.length };
}
```

复杂度 << puppeteer,工时从悲观 +2 天回到乐观 +1 天。

---

## 2. 探索过程

### 2.1 试探的失败路径(全 404)

```
GET /api/papers/{id}/discussions             → 404
GET /api/papers/{id}/discussion              → 404
GET /api/papers/{id}/discussions/{discId}    → 404
GET /api/discussions/{discId}                → 404
GET /api/papers/{id}/discussion/1            → 404
GET /api/papers/{id}/discussions/1           → 404
```

HF discussion 没有公开的 REST API endpoint。

### 2.2 SSR 框架探测(全否)

| 框架 | 探测 | 结果 |
|------|------|------|
| Next.js (Page Router) | `__NEXT_DATA__` 出现次数 | 0 |
| Nuxt | `__NUXT__` | 0 |
| Next.js 13+ App Router | `self.__next_f` | 0 |
| SvelteKit | `__sveltekit` | 0 |
| Vue | `__INITIAL_STATE__` | 0 |
| Inertia | `__APP_DATA__` | 0 |

→ HF 用的不是标准 SSR 框架的 hydration 模式。

### 2.3 找到真相 — Svelte `SVELTE_HYDRATER` 自定义模式

HF 用 Svelte 自定义渲染,所有数据通过 HTML `data-props` attribute 嵌入。模式:

```html
<div class="SVELTE_HYDRATER contents"
     data-target="PaperContent"
     data-props="{... HTML-encoded JSON ...}">
  <!-- hydrated client-side -->
</div>
```

`data-props` 是一个超大字符串(实测 117KB,paper `2605.13301`),内含 `comments / paper / upvoters / dailyPaperRank / markdownContentUrl` 等全部数据。

### 2.4 完整 data-props top-level keys

```
['comments', 'primaryEmailConfirmed', 'paper', 'canReadDatabase',
 'canManagePapers', 'canSubmit', 'hasHfLevelAccess', 'upvoted',
 'upvoters', 'acceptLanguages', 'dailyPaperRank', 'markdownContentUrl']
```

---

## 3. comments 字段全集(基于多 paper sample)

### 3.1 字段结构(verify 多条)

```jsonc
{
  "id": "6a06826789940d9a9d9878c8",                // HF 内部 comment ID
  "author": {                                       // 顶层 author(创建时快照)
    "_id": "63f3502a520c14618925825a",
    "avatarUrl": "/avatars/...svg"                  // 相对路径(走 huggingface.co)
                  | "https://cdn-avatars.huggingface.co/v1/.../...jpeg",
    "fullname": "Yafu Li",
    "name": "yaful",                                // handle
    "type": "user",
    "isPro": false,
    "isHf": false,
    "isHfAdmin": false,
    "isMod": false,
    "followerCount": 9,
    "isUserFollowing": false
  },
  "createdAt": "2026-05-15T02:18:15.000Z",
  "type": "comment",                                // 当前看到的全是 "comment"
  "data": {
    "edited": true,
    "hidden": false,
    "latest": {                                     // 当前版本内容(支持编辑历史)
      "raw": "markdown 原文...",
      "html": "<p>rendered HTML</p>",
      "updatedAt": "...",
      "author": { ... }                             // latest editor
    },
    "numEdits": 0,
    "identifiedLanguage": {
      "language": "en",
      "probability": 0.722
    },
    "editors": ["librarian-bot"],
    "editorAvatarUrls": [...],
    "reactions": [                                  // emoji 反应聚合(不是简单 like count)
      { "reaction": "👍", "users": [...], "count": 10 },
      { "reaction": "🔥", "users": [...], "count": 6 },
      { "reaction": "➕", "users": ["loretoparisi"], "count": 1 }
    ],
    "isReport": false
  }
}
```

### 3.2 重要 verify 结果

| 项 | 结果 |
|----|------|
| 匿名 fetch(无 Authorization header) | ✅ HTTP 200,comments 完整 |
| `User-Agent: Mozilla/5.0` 是否需要 | ✅ 是(纯 curl 没 UA 头可能被 ban) |
| 多 paper 兼容性 | ✅ 高 upvote(140)+ 低 upvote(3)都解析成功 |
| 0 comments paper | ✅ 返 `comments: []` 不报错 |
| Comment 含完整作者信息 | ✅ `author.fullname / name / avatarUrl / isPro / isHf` 全有 |
| Comment 含原文 + rendered HTML | ✅ `data.latest.raw`(markdown)+ `data.latest.html` |
| Author 是 paper submitter 标记 | ⚠️ 没有显式 flag,需要 BE 推算 `comment.author._id === paper.submittedOnDailyBy._id` |
| Likes / reactions 字段 | ⚠️ 不是 `like_count`,是 `reactions: [{emoji, count, users}]`。需要 BE 简化为 `{emoji, count}` 数组(去掉 `users`)或单独抽 `like_count = 👍 count` 兜底字段 |
| 编辑历史 | ✅ `data.edited` + `numEdits` + `editors[]`(可选展示) |
| 自动识别语言 | ✅ `data.identifiedLanguage`(可用于翻译跳过 zh 已经是中文的评论) |

### 3.3 待 BE field design 更新

`extra.discussion_comments[]` 字段表(更新版,跟 §3.2 同步):

```jsonc
{
  "id": "<comment.id>",
  "author_name": "<comment.author.fullname>",
  "author_handle": "<comment.author.name>",
  "author_avatar_url": "/r/hf/<sha>",                         // R2 迁移后
  "raw_author_avatar_url": "<comment.author.avatarUrl>",      // 原 URL 备份
  "is_pro": <comment.author.isPro>,
  "is_hf_admin": <comment.author.isHfAdmin>,
  "content": "<comment.data.latest.raw>",                     // markdown 原文
  "content_html": "<comment.data.latest.html>",               // rendered HTML(FE 直渲)
  "content_zh": "<flash 翻译,跳 zh 评论>",
  "posted_at": "<comment.createdAt>",
  "updated_at": "<comment.data.latest.updatedAt>",
  "edited": <comment.data.edited>,
  "is_author_reply": <bool>,                                  // BE 推算
  "language": "<comment.data.identifiedLanguage.language>",   // 用于翻译 skip
  "reactions": [{ "emoji": "👍", "count": 10 }, ...],          // 简化(去 users[])
  "like_count": <👍 reaction.count 或 0>                       // 兜底单值
}
```

---

## 4. 实施细节(BE Phase 3)

### 4.1 `fetch-discussion.ts` 伪代码

```typescript
import { unescapeHtml } from '../lib/html-unescape';

const SSR_PROPS_RE = /<div class="SVELTE_HYDRATER contents" data-target="PaperContent" data-props="([^"]*)"/;

export async function fetchDiscussionForHfPaper(
  env: EnrichEnv,
  itemId: string,
  arxivId: string,
): Promise<{ fetched: boolean; comments_count: number }> {
  // 1. fetch web page(匿名 + User-Agent)
  const resp = await fetch(`https://huggingface.co/papers/${arxivId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
  });
  if (!resp.ok) {
    console.warn(`[hf-paper] fetch discussion fail ${arxivId}: HTTP ${resp.status}`);
    return { fetched: false, comments_count: 0 };
  }
  const html_text = await resp.text();

  // 2. regex 提 data-props
  const m = html_text.match(SSR_PROPS_RE);
  if (!m) {
    console.warn(`[hf-paper] PaperContent data-props 未匹配 ${arxivId}`);
    return { fetched: false, comments_count: 0 };
  }

  // 3. HTML decode + JSON parse
  let props: any;
  try {
    props = JSON.parse(unescapeHtml(m[1]));
  } catch (e) {
    console.error(`[hf-paper] data-props JSON parse fail ${arxivId}: ${e}`);
    return { fetched: false, comments_count: 0 };
  }

  const rawComments = props.comments || [];
  const paperSubmitterId = props.paper?.submittedOnDailyBy?._id;

  // 4. 映射 + 推算 is_author_reply
  const comments = rawComments.map((c: any) => ({
    id: c.id,
    author_name: c.author.fullname,
    author_handle: c.author.name,
    raw_author_avatar_url: c.author.avatarUrl,
    author_avatar_url: c.author.avatarUrl,        // R2 迁移后 step 改成 /r/hf/<sha>
    is_pro: c.author.isPro,
    is_hf_admin: c.author.isHfAdmin,
    content: c.data?.latest?.raw || '',
    content_html: c.data?.latest?.html || '',
    posted_at: c.createdAt,
    updated_at: c.data?.latest?.updatedAt,
    edited: c.data?.edited || false,
    is_author_reply: c.author._id === paperSubmitterId,
    language: c.data?.identifiedLanguage?.language,
    reactions: (c.data?.reactions || []).map((r: any) => ({
      emoji: r.reaction,
      count: r.count,
    })),
    like_count: (c.data?.reactions || []).find((r: any) => r.reaction === '👍')?.count || 0,
  }));

  // 5. 写入 extra.discussion_comments(SQL UPDATE json_set)
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(coalesce(extra, '{}'),
      '$.discussion_comments', ?,
      '$.discussion_fetched_at', ?,
      '$.discussion_fetch_method', 'svelte_ssr')
      WHERE id = ?`,
  ).bind(JSON.stringify(comments), new Date().toISOString(), itemId).run();

  return { fetched: true, comments_count: comments.length };
}
```

### 4.2 评论者 avatar R2 迁移

跟 §6 媒体迁移合并:`backfill-media-r2` step 改成接收一个 url list(`[thumbnail, submitter_avatar, ...comment_author_avatars]`),迁完后回写 `extra` 中各处的 `/r/hf/<sha>` 路径。

### 4.3 失败容错

- HTTP 非 200 → 返 `fetched: false`,workflow 不阻断;`/api/items` filter 仍展示(无评论 paper 是常态)
- regex 不匹配 → HF 改版可能(走 `pushDeerAlert` 告警 + 保留 fail-safe)
- JSON parse 失败 → 同上
- 后续 cron backfill 重试(新 hour-bucket instance)

---

## 5. OPS 影响

### 5.1 #2 Verify CF Browser Rendering 在 Paid plan 可用 — **不需要做了** ✅

不走 puppeteer,不用 `wrangler.toml` 加 `[browser] binding`,不用占 10h/月 Browser Rendering 配额。

OPS 工作量减少 15 min 一次性 verify。

### 5.2 其他 OPS 工作不变

- #1 Budget alert "不设上限"
- #3 R2 bucket cap 监控
- #4 CF Workflows 配额 verify(8 段 fan-out 仍然需要 verify)
- #5 DeepSeek 月度成本监控
- #6 arxiv.org API 监控

---

## 6. 风险登记更新

去掉:
- ~~NEW #3:HF discussion API 全 404 → 必须 puppeteer~~

新增:
- **HF 改版 PaperContent data-props 结构变**:中。fetch fail-safe + `pushDeerAlert` 告警 + Phase 0.5 文档可作为下次 reconnaissance 参考
- **HF web page rate limit**:低。1 次/天 × 50 paper,远低于 IP rate limit(实测未触发)
- **HTML 大小波动**:111-200KB 单次 fetch,CF Workers 内存够用(默认 128MB)

---

## 7. 决策

**Phase 3 走 SSR 解析路径**:
- 实现工时:**+1 天**(乐观值实现)
- 总工时:**11.75 天**
- 无需 OPS #2 verify
- 无需 CF Browser Rendering binding

Phase 1 启动!

# 站长平台验证 + Sitemap 提交指引（Google / Bing）

> 这份文档写给「不做运营、只写代码」的自己看。每一步都说清楚**在哪个网站点哪里、为什么要这么做**。
> 全程一次性手工操作，做完基本不用再管（后续新页由 IndexNow 自动通知，见文末）。
>
> **前置状态（2026-07-06 已就位，无需你做）**：
> - `.com` 主站已经能吐出给搜索引擎看的静态页：日报页 `https://ai-feeds.com/daily/2026-07-06`、归档 `https://ai-feeds.com/daily/`
> - 站点地图已就绪：`https://ai-feeds.com/sitemap.xml`（列出首页 + 归档 + 每一天的日报页）
> - 爬虫规则已就绪：`https://ai-feeds.com/robots.txt`（放行所有搜索引擎和 AI 爬虫）
> - 你现在要做的，只是**去 Google 和 Bing 那边「登记」这个网站，然后把 sitemap 交给它们**，让它们开始来抓。

---

## 先搞懂几个名词

- **站长平台（Webmaster Tools / Search Console）**：搜索引擎给网站主开的后台。你在这里「认领」自己的网站，之后能看到：Google 收录了你哪些页、有没有抓取报错、用户搜什么词点进来。不登记也能被收录，但登记后能**主动提交 sitemap 催收录 + 看数据**。
- **验证域名所有权（Verify ownership）**：Google 不能让任何人随便认领 `ai-feeds.com`，得先证明「这域名是你的」。最稳的证明方式是**在域名的 DNS 里加一条它指定的记录** —— 只有能改 DNS 的人（=域名主人）才做得到。
- **DNS TXT 记录**：DNS 是「域名 → 服务器地址」的电话簿。TXT 记录是电话簿里一种「纯文本备注」，不影响网站访问，专门用来放各种验证串。Google 给你一串字符串，你把它贴进 DNS 的 TXT 记录，Google 一查到就认可你是主人。
- **Sitemap（站点地图）**：一个列出「本站所有值得收录的网址」的 XML 文件。交给搜索引擎后，它照着这个清单去抓，比它自己瞎逛效率高。我们的 sitemap 会随每天新日报自动更新。
- **IndexNow**：一个「网站有新页了，主动敲搜索引擎的门」的协议（Bing / Yandex 支持，Google 不直接支持但会参考）。我们的 worker 每天早 8 点生成日报后已经自动 ping，**这部分不用你管**。

---

## 关于我们域名的一个关键事实

`ai-feeds.com` 这个域名是**在 Cloudflare 注册 + 由 Cloudflare 托管 DNS** 的。所以下面所有「加 DNS 记录」的动作，都是**登录 Cloudflare 后台，在这个域名的 DNS 面板里操作**，不是去别的地方。

还有一点容易踩坑：我们主站的几条记录（`@` / `www` / `api` / `fonts`）是**灰云（DNS only，直连香港 VPS）**的，不走 Cloudflare 橙云代理（原因见 `docs/operations.md` §6b）。**但这不影响验证** —— 验证用的 TXT 记录本来就不走代理、跟橙云灰云无关，照常加即可。

---

## 一、Google Search Console

### 1. 打开并登录

浏览器访问 <https://search.google.com/search-console/>，用你的 Google 账号登录（就是平时用的那个 Google 账号即可）。

### 2. 添加资源（Add property）

进去后左上角有个下拉，点「**添加资源 / Add property**」。它会问你选哪种类型：

- **网域（Domain）** ← **选这个**
- 网址前缀（URL prefix）

> **为什么选「网域」而不是「网址前缀」**：网域类型一次覆盖 `ai-feeds.com` 下所有子域和 http/https，最省事；代价是**只能用 DNS TXT 验证**（网址前缀类型才支持上传 HTML 文件那种）。我们本来就能改 DNS，所以选网域最合适。

在输入框里填：`ai-feeds.com`（只填裸域名，不要带 `https://`、不要带 `/`）。点「继续」。

### 3. 拿到验证串

Google 会弹出一段文字，让你「通过 DNS 记录验证所有权」，并给你一条 **TXT 记录的值**，形如：

```
google-site-verification=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

把这一整串**复制下来**（先别关这个页面，稍后回来点「验证」）。

### 4. 去 Cloudflare 加这条 TXT 记录

1. 另开一个标签页，登录 <https://dash.cloudflare.com/>
2. 选中 `ai-feeds.com` 这个站点 → 左侧菜单 **DNS** → **Records（记录）**
3. 点「**Add record（添加记录）**」，填：
   - **Type（类型）**：`TXT`
   - **Name（名称）**：填 `@`（表示裸域名 `ai-feeds.com` 本身）
   - **Content（内容）**：粘贴刚才复制的整串 `google-site-verification=...`
   - **TTL**：保持 `Auto` 即可
   - **Proxy status**：TXT 记录没有橙云/灰云选项，不用管
4. 保存

### 5. 回 Google 点「验证」

回到第 3 步那个 Google 页面，点「**验证 / Verify**」。

- DNS 记录一般几分钟内生效，但有时要等十几分钟到半小时。**如果第一次点验证失败，别急，等 10 分钟再点一次**，通常就过了。
- 验证成功 = 你正式拥有这个资源的后台了。

### 6. 提交 Sitemap

验证通过后，在左侧菜单找到「**站点地图 / Sitemaps**」，在「添加新的站点地图」输入框里填：

```
sitemap.xml
```

（它已经知道域名是 `ai-feeds.com`，你只要补后面的路径 `sitemap.xml`。完整地址就是 `https://ai-feeds.com/sitemap.xml`。）点「提交」。

提交后状态一开始可能显示「无法获取 / Couldn't fetch」，这是**正常的延迟**，Google 排队去抓，过几小时到一天会变成「成功 / Success」并显示发现了多少个网址。

---

## 二、Bing Webmaster Tools

Bing 这套跟 Google 几乎一样，而且**支持从 Google Search Console 一键导入**，能省掉重复验证。

### 走捷径：从 GSC 导入（推荐）

1. 访问 <https://www.bing.com/webmasters/>，用微软账号登录（没有就注册一个，或直接用 Google 账号登录，Bing 支持）
2. 首页会给两个选项：「**Import from Google Search Console（从 GSC 导入）**」和「手动添加」
3. 选「从 GSC 导入」→ 授权 Bing 读取你的 GSC 账号 → 它会列出你在 GSC 里已验证的 `ai-feeds.com`，勾选导入
4. 导入后**域名所有权和 sitemap 会一并带过来**，通常不用再单独验证、也不用再手动交 sitemap

### 备选：手动验证（万一导入不可用）

如果不想授权导入，也可以手动加：添加站点 `https://ai-feeds.com`，Bing 同样支持 **DNS TXT 验证**（给你一串 `MS=xxxx`，跟 Google 一样贴进 Cloudflare 的 TXT 记录，Name 填 `@`），验证后到「Sitemaps」提交 `https://ai-feeds.com/sitemap.xml`。

---

## 三、IndexNow 已自动化，无需手动

我们的 worker 每天早 8 点生成当天日报静态页后，会**自动通过 IndexNow 协议把新页 + 归档 + sitemap 通知出去**（Bing / Yandex 直接消费，Google 会参考）。

- 校验文件 `https://ai-feeds.com/<INDEXNOW_KEY>.txt` 已由 worker 伺服，key 值存在 `.secrets/aifeeds-prod.env`（`INDEXNOW_KEY`）
- 所以 **Bing 那边你不需要再单独配 IndexNow key**，日常新页收录靠这个自动跑
- 代码见 `worker/src/digest/daily-page-run.ts` 的 `pingIndexNow`；运维说明见 `docs/operations.md` §「每日静态日报页 Phase 4」

---

## 四、怎么确认「有没有被收录」

收录是搜索引擎的自主行为，**急不来**。新站从提交到出现在搜索结果里，通常要**几天到几周**，别提交完第二天就去搜、搜不到就慌。查进度的两个办法：

1. **`site:` 查询**（最快的粗略估计）：在 Google 搜索框里输入 `site:ai-feeds.com`，回车。结果里列出的就是 Google 已经收录的本站页面。数字从 0 慢慢往上涨就是好兆头。Bing 同理，在 bing.com 搜 `site:ai-feeds.com`。
2. **GSC 覆盖率报告**（最准）：Google Search Console 左侧「**索引 / Pages（网页）**」报告，能看到「已编入索引 / 未编入索引」各多少、未收录的原因（比如「已抓取但暂未编入索引」是正常排队状态）。sitemap 报告里也能看它从 sitemap 发现了多少 URL、收录了多少。

> **心理预期**：新域名 + 内容页刚上线，Google 会先小批量试抓、观察站点质量，再逐步放量收录。头两周 `site:` 数字很小甚至是 0 都属正常。持续每天有新日报、sitemap 持续更新、IndexNow 持续 ping，收录量会稳步爬升。真正长期不收录（几周后仍 0）才需要回来查 robots.txt / 抓取报错 / 内容质量。

---

## 一句话回顾

Google 走一次 DNS TXT 验证 + 交 sitemap；Bing 从 GSC 导入即可；IndexNow 全自动不用管；剩下的就是**耐心等收录**，用 `site:` 和 GSC 覆盖率报告盯进度。

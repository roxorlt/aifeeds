# ai-feeds.cc 国内搜索资源提交操作手册

> 适用站点：`https://ai-feeds.cc`
> 平台：百度搜索资源平台、360 站长平台、搜狗搜索资源平台、神马站长平台
> 状态基线：2026-07-21；四家站点所有权验证均已通过；国内兼容 sitemap 已部署并完成首期生产验收
> 原则：先确认生产页面与 sitemap 真实可抓取，再在平台中提交；提交不等于保证抓取、收录或排名。

## 1. 当前结论

| 平台 | 当前能否提交 | 本次正式提交对象 | 结论 |
|---|---:|---|---|
| 360 | 可以 | `https://ai-feeds.cc/sitemap-cn.xml` | 稳定一级索引；已通过生产验收，可以提交 |
| 搜狗 | 取决于账号权限 | `https://ai-feeds.cc/sitemap-cn.xml` | 稳定一级索引；sitemap 工具采用邀请制，先检查账号是否获邀 |
| 百度 | 可以逐片提交 | `https://ai-feeds.cc/sitemap-static.xml`、`https://ai-feeds.cc/sitemap-cn-0001.xml` | 当前只有 `0001`；百度普通收录不处理索引型 sitemap，不提交 `sitemap-cn.xml` 或 `/sitemap.xml` |
| 神马 | 可以 | `https://ai-feeds.cc/sitemap-cn.xml` | 已通过生产验收；每片最多 10,000 URL，索引每个子项均带真实 `lastmod` |

因此不要把同一个 `/sitemap.xml` 不加检查地提交给四家。生产首发顺序建议为：

1. 360 与神马提交 `sitemap-cn.xml`；
2. 检查搜狗邀请与资质状态，满足条件后提交同一个稳定索引；
3. 百度提交 `sitemap-static.xml` 与 `sitemap-cn-0001.xml`；
4. 观察 24～48 小时平台状态。以后只有当 `sitemap-cn.xml` 真实列出新叶子时，百度才增加对应编号，绝不预先提交不存在的 `0002`。

## 2. 已实现的 sitemap 兼容层

### 2.1 已有实现

- 稳定入口：`https://ai-feeds.cc/sitemap.xml`；
- 根文件类型：`<sitemapindex>`；
- 内容叶子：`/sitemaps/<generation-v4-uuid>/<source>-<n>.xml`；
- 每个内容叶子最多 45,000 URL；
- generation URL 不可变，但旧 generation 正常只保留约 4 小时；
- `sitemap-static.xml` 是稳定的标准 `<urlset>`，当前包含首页与固定公开页；
- `robots.txt` 已声明 `Sitemap: https://ai-feeds.cc/sitemap.xml`。

这一设计适合通用 crawler 从稳定根索引发现短期不可变叶子，但不满足“平台长期登记一个标准 URL 列表文件”的全部要求。

### 2.2 国内平台稳定文件

新增一套稳定的国内平台提交文件，同时保留现有 generation sitemap：

```text
https://ai-feeds.cc/sitemap-cn.xml
https://ai-feeds.cc/sitemap-cn-0001.xml
https://ai-feeds.cc/sitemap-cn-0002.xml
https://ai-feeds.cc/sitemap-cn-0003.xml
...
```

上面 `0002`、`0003` 仅表示容量增长后的命名规则。2026-07-21 的生产索引实际只列出
`sitemap-static.xml` 与 `sitemap-cn-0001.xml`，因此本次不得提交任何更高编号。

实现保证：

- `sitemap-cn.xml` 是稳定的一层索引，子项都带真实 `lastmod`；
- 每个 `sitemap-cn-NNNN.xml` 是标准 `<urlset>`，最多 10,000 URL、UTF-8、未压缩时小于 10 MB；
- 叶子 URL 稳定，不含 generation UUID，Nginx 通过原子 `current` 入口读取当代文件；
- 叶子仅包含 `https://ai-feeds.cc/` 下允许公开的 200 页面；
- 页数减少时，已被百度登记过的旧叶子编号不能突然变成任意文件或错误内容；应保留安全的空 `<urlset>`，或在百度平台先删除登记再下线；
- 发布器校验每片 URL 数与文件大小；部署事务再验证 Nginx 用户可读，并对稳定索引与第一片做本机 HTTPS 200 精确字节比对；生产提交前仍按第 3 节检查全部叶子与页面；
- `sitemap-static.xml` 继续独立存在。百度直接登记 `sitemap-static.xml` 与各个 `sitemap-cn-NNNN.xml`；360、搜狗、神马可登记 `sitemap-cn.xml`。

旧 generation 的 manifest 没有新字段时仍可恢复和回收；首次运行新版发布器会因 sitemap URL schema 升级重建完整 generation。manifest 记录叶子高水位，数据缩小时曾发布的旧编号继续返回空的合法 `<urlset>`，不会让百度已登记地址突变为 404。

## 3. 生产提交前共同门禁

本节任何一项失败，都先修站点，不进入站长平台点击提交。

### 3.1 所有权验证文件

下列地址应持续返回 HTTP 200，内容与四家平台下载的原文件完全一致：

- 360：`https://ai-feeds.cc/372c4ae2a3701bbe3b091dff54fb6d14.txt`
- 搜狗：`https://ai-feeds.cc/sogousiteverification.txt`
- 神马：`http://ai-feeds.cc/shenma-site-verification.txt`
- 百度：`https://ai-feeds.cc/baidu_verify_codeva-OHhjgzJndf.html`

不要在内容镜像部署、清理站点根目录或更换 Nginx 配置时删除这些文件。神马验证文件保留 HTTP 直出 200 的例外；其他 HTTP 页面仍可跳 HTTPS。

### 3.2 HTTP 与页面语义

抽查首页、归档页和至少 20 个内容页：

- HTTPS 最终响应为 200；页面本身不自动跳到 `.com`；
- `<link rel="canonical">` 与 `og:url` 指向当前 `.cc` 页面，而不是 `.com`；
- 没有 `noindex`、登录墙、验证码或仅 JavaScript 渲染的空壳；
- 标题、中文正文/摘要、来源说明和发布时间可在初始 HTML 中读取；
- “打开互动版”等按钮由用户点击后才跳往 `.com`，不使用 meta refresh 或脚本自动跳转；
- 归档普通链接能逐级发现内容页；移动端可正常阅读；
- 过滤为 deny、pending 或人工 review 的内容不出现在页面、归档或任何 sitemap 中。

### 3.3 robots 与 sitemap

上线后执行：

```bash
curl -fsS https://ai-feeds.cc/robots.txt
curl -fsS https://ai-feeds.cc/sitemap.xml
curl -fsS https://ai-feeds.cc/sitemap-static.xml
curl -fsS https://ai-feeds.cc/sitemap-cn.xml
curl -fsS https://ai-feeds.cc/sitemap-cn-0001.xml
```

确认：

- `robots.txt` 返回 200，包含 `Sitemap: https://ai-feeds.cc/sitemap.xml`；
- 未禁止 `Baiduspider`、`360Spider`、搜狗 spider 或 `yisouspider` 抓取公开页面；
- sitemap 中只有 `.cc` URL，不得混入 `.com` CTA、后台、工作台、API、验证文件或被过滤内容；
- 根索引列出的每一个叶子都返回 200 和 `application/xml`；
- `sitemap-cn.xml` 是一层索引，每个子项都有 `lastmod`，且稳定叶子名严格为 `sitemap-cn-NNNN.xml`；
- 每个 CN 叶子不超过 10,000 个 `<url>`、小于 10 MB，所有 `<loc>` 不超过 256 字节；
- 每个 URL 只出现一次，且其页面返回 200、自 canonical；
- sitemap URL 总数等于 VPS 同步 state 中 live page 数，加上明确列出的静态页和归档页；
- 内容删除后从 sitemap 移除，页面返回 404 或 410，不做软 404。

可以用以下只读检查保存验收证据：

```bash
curl -fsSI https://ai-feeds.cc/sitemap.xml
curl -fsS https://ai-feeds.cc/sitemap.xml | xmllint --noout -
curl -fsSI https://ai-feeds.cc/sitemap-cn.xml
curl -fsS https://ai-feeds.cc/sitemap-cn.xml | xmllint --noout -
curl -fsS https://ai-feeds.cc/sitemap-cn-0001.xml | xmllint --noout -
curl -fsS https://ai-feeds.cc/robots.txt | grep -F 'Sitemap: https://ai-feeds.cc/sitemap.xml'
```

生产提交时把检查日期、根 sitemap 的 SHA-256、根索引叶子数、内容 URL 总数和 20 个抽样 URL 记入操作记录。

### 3.4 2026-07-21 首期生产验收记录

当前冻结清单可直接用于本轮平台提交：

| 文件 | 结构与数量 | 字节数 | SHA-256 |
|---|---:|---:|---|
| `https://ai-feeds.cc/sitemap.xml` | sitemap index，3 个子项 | 412 | `f329cd4108360f7f8c7b049fc6be08d41b7649a8a02113d8f4f05c5ae932ddc1` |
| `https://ai-feeds.cc/sitemap-cn.xml` | sitemap index，2 个子项 | 351 | `27952b6f718721dd9145dcddeed060231cea3c2525e267365e109fa4513a8f41` |
| `https://ai-feeds.cc/sitemap-cn-0001.xml` | urlset，140 个 URL | 12,504 | `cc891d22fa841dcb18238b5fb403d8a60a62568f550e496d7b1e02e6767389da` |
| `https://ai-feeds.cc/sitemap-static.xml` | urlset，8 个 URL | 628 | `20b3c7498fef4095a9af01cb2f12f8d0aaa15503af1dddeac83ebc649c9c9e5c` |

计数口径：`sitemap-cn-0001.xml` 包含 137 个内容页与 3 个归档页；再加 8 个固定页，
四家可发现的唯一 URL 合计 148。VPS state 为 `last_seq=163`、`bootstrap=null`、137 个
live 页面，与 sitemap 完全一致。

验收结果：

- 四份 XML 均可解析并返回 200；148 个 sitemap URL 均直接返回 200，无跳转；
- 137 个内容页全部为精确自 canonical，无 `noindex`、meta refresh 或脚本自动跳转，`.com`
  CTA 都带 `utm_source=cc&utm_medium=mirror&utm_campaign=cn_seo`；
- 逐页执行内容策略 v5 的政治治理、军事冲突、制裁/出口管制、严重伤害与对华负面确定性
  backstop，137/137 无命中；固定抽样 50 个标题与摘要再次人工复核，无新增阻断项；
- 首期三家海外第三方媒体共审核 219 条：137 条 live、82 条 deny；13 个曾短暂公开后撤回的
  URL 均直接返回 404，且不在归档或 sitemap；
- 360、搜狗、神马、百度四个验证文件均直接返回 200；神马的 HTTP 验证文件没有被重定向；
- `aifeeds-cc-sync.timer` 为 `active` 且 `enabled`。生产 `CC_MIRROR_ENABLED` 仍保持关闭，
  当前只发布经过人工分批回填和验收的首期内容，不自动扩张到其他来源。

## 4. 360 站长平台

入口：[360 站长平台 Sitemap 提交](https://zhanzhang.so.com/sitetool/sitemap)

### 4.1 首次提交

1. 登录并在站点选择器中选 `ai-feeds.cc`。
2. 进入“数据提交 → Sitemap 提交”。
3. 确认列表中没有错误的旧域名或测试文件。
4. 点击“添加新数据”。
5. 在“数据文件地址”填写 `https://ai-feeds.cc/sitemap-cn.xml`。
6. 人工填写页面验证码。
7. 再核对一次域名与协议后，点击“添加”。
8. 截图或记录提交时间、文件 URL 与页面返回状态。

当前页面说明支持标准 XML、文本和 sitemap index；单个内容 sitemap 不超过 50,000 URL、10 MB。现有 45,000 分片符合数量上限，但仍要以生产实测文件大小为准。

### 4.2 提交后操作

- 当天：在“抓取诊断”分别检查首页、`/ai-news/`、一个深层归档页和 5 个内容页；
- 第 2～3 天：看 Sitemap 状态是否已抓取、是否有解析/访问错误；
- 第 7 天：记录“索引量查询、流量分析、关键词分析、蜘蛛压力”；
- 若蜘蛛压力过大，先查 5xx、带宽和日志，再谨慎调节抓取压力；不要因为收录慢而反复添加同一个 sitemap；
- 内容永久删除时，从 sitemap 移除并在“死链提交”中提交稳定的死链文件。

“自动收录”外部 JavaScript 不是首发必需项。静态内容镜像已有 sitemap 和普通内链，首周不建议为了收录额外插入第三方脚本。

## 5. 搜狗搜索资源平台

入口：[搜狗 Sitemap 提交帮助](https://zhanzhang.sogou.com/index.php/help/sitemap)

### 5.1 先确认两层权限

站点文件验证通过不等于拥有完整提交权限：

1. 在“用户中心 → 网站管理”确认站点至少为“已验证根目录”；
2. 如页面要求资质，继续提交备案主体、网站基础资料与运营者信息；官方说明资质审核通常在 7 个工作日内完成；
3. 进入“Sitemap 提交”，选择 `ai-feeds.cc`，检查是否已经获得邀请。

搜狗 sitemap 采用邀请制。若未获邀，不要在其他输入框绕过权限，也不要虚构原创权利。可以向 `zzpt@tencent.com` 如实申请，建议邮件内容：

```text
主题：申请开通 ai-feeds.cc Sitemap 提交权限

站点：https://ai-feeds.cc
验证账号：<平台账号>
ICP备案：${ICP_BEIAN_NO}
站点内容：海外 AI 公开信源的筛选、中文翻译与独立摘要；保留来源标注，
          国内新闻来源与非 AI、对华负面等风险内容不进入公开镜像。
页面规模：约 <实际 live 数> 个内容页
归档入口：https://ai-feeds.cc/ai-news/
Sitemap：https://ai-feeds.cc/sitemap-cn.xml
抓取问题或申请理由：<如实填写；若 spider 可正常抓取，不要声称无法抓取>
抽样页面：
1. <URL>
2. <URL>
3. <URL>
```

### 5.2 获邀后的提交

1. 进入“Sitemap 提交”，选择 `ai-feeds.cc`；
2. 填写 `https://ai-feeds.cc/sitemap-cn.xml`；
3. 提交后记录状态；
4. 状态含义按平台帮助理解：“已提交”是收到地址，“等待”是排队，“正常”才表示文件被正常处理，“等待更新”表示等待再次抓取；
5. 若失败，依次检查：公网可访问、文件属于已验证域名及目录、是否重复、XML 是否有效、是否为一级索引、每个文件是否小于 50,000 URL 和 10 MB。

搜狗允许 txt、XML 和一级 XML 索引，最多 100 个文件。提交不保证收录或排名。验证文件必须长期保留，搜狗官方明确提示删除后可能失去验证状态。

### 5.3 后续工具

- 第 7 天开始记录“收录索引、网站流量、网站关键词、抓取压力”；
- 发生大批永久删除时使用“死链提交”；
- 当前是同 URL 响应式页面，不需要提交 PC→M 的“移动适配”；
- 没有域名迁移，不使用“域名变更”。

## 6. 百度搜索资源平台

入口：[百度普通收录](https://ziyuan.baidu.com/linksubmit/index)

### 6.1 不要提交任何 sitemap index

百度普通收录的官方手册与常见问题明确说明：sitemap 文件要直接包含站点 URL，索引型 sitemap 不予处理。当前 `/sitemap.xml` 是索引，因此不要尝试提交后等待碰运气。

现有 generation 叶子地址也不要登记：它们形如 `/sitemaps/<uuid>/news-1.xml`，是给根索引临时引用的不可变文件，旧代会回收，不是长期提交地址。

### 6.2 首次提交顺序

1. 进入“资源提交 → 普通收录”。
2. 如果有“Sitemap”标签，先提交 `https://ai-feeds.cc/sitemap-static.xml` 与 `https://ai-feeds.cc/sitemap-cn-0001.xml`。
3. 等待 24～48 小时；首片状态正常后，把生产 `sitemap-cn.xml` 当前列出的其余 `sitemap-cn-NNNN.xml` 逐个登记。不要凭预计页数填写不存在的编号。
4. 在“手动提交”中可另提交少量种子 URL：
   - `https://ai-feeds.cc/`
   - `https://ai-feeds.cc/ai-news/`
   - 最新归档页；
   - 10～20 个通过人工抽查的高质量内容页，覆盖 news、X、GitHub、Product Hunt、HF Paper。
5. 不提交 `.com` CTA 目标，不提交同内容的多个参数 URL，不提交 pending/deny 页。
6. 首周观察自然抓取和质量反馈，不把 3 万历史 URL 一次性塞进手动或 API 通道。

“普通收录”只缩短发现链接的时间，不能解决内容是否收录。若账号显示“快速抓取”，它是平台按权益开放的稀缺通道，只用于最新、高时效且经过审核的少量内容，不用于历史回填。

### 6.3 百度最终可登记文件

百度不能提交 `sitemap-cn.xml` 索引，应逐个登记：

```text
https://ai-feeds.cc/sitemap-static.xml
https://ai-feeds.cc/sitemap-cn-0001.xml
https://ai-feeds.cc/sitemap-cn-0002.xml
...
```

每个文件最多 50,000 URL、10 MB；本项目统一按神马更严的 10,000 URL 分片。先提交一个文件观察 24～48 小时状态正常，再补齐其余文件。页面中显示的文件存量与日配额以当前账号为准。

### 6.4 API 推送

国内平台专用 sitemap 稳定运行且首周质量正常后，可另做“当天新增 URL”API 推送：

- token 只保存在服务器 secret，不进入 Git、日志或前端；
- 只推送本轮新变为 live 的 `.cc` URL；
- 先推 10 条验证响应码，再按账号当日额度分批；
- 重试只针对明确的暂时错误，记录百度返回码和成功数量；
- API 推送与 sitemap 可以并存，但不要用 API 重灌 3 万历史页面。

### 6.5 提交后操作

- “抓取诊断”：首页、归档与五类内容页各至少 1 条；
- “抓取异常”：检查 DNS、连接、超时、4xx/5xx；
- “Robots”：确认公开路径未被屏蔽；
- “索引量、流量与关键词、抓取频次”：第 7、14 天记录基线；
- “站点属性”：如要提交站点名称或 Logo，使用备案主体和实际品牌资料，不影响 sitemap 首发；
- 永久删除内容时使用“死链提交”，文件只放真实 404/410 URL。

## 7. 神马站长平台

入口：[神马 Sitemap 官方格式说明](https://zhanzhang.sm.cn/open/helpsitemap)

### 7.1 不提交通用根文件

神马支持标准 XML 与最多三层 sitemap index，但有两项更严格要求：

- 每个标准 XML 最多 10,000 URL；
- 官方顶层索引格式把每个子 sitemap 的 `lastmod` 标为必填。

通用 `/sitemap.xml` 仍按 45,000 上限组织 generation 分片，索引子项也不承诺 `lastmod`，因此不要提交它。专用 `/sitemap-cn.xml` 已按神马约束生成，才是正式提交入口。

### 7.2 提交步骤

1. 先验证 `sitemap-cn.xml` 是一层索引、每个子项都有 `lastmod`；
2. 逐个检查所有叶子 URL 数 `<= 10000`，URL 长度不超过 256 字节，UTF-8，页面为移动端可读的 HTTPS 200；
3. 登录神马站长平台，选择 `ai-feeds.cc`；
4. 进入“站长工具 → Sitemap 提交”；
5. 填写 `https://ai-feeds.cc/sitemap-cn.xml`；
6. 提交后记录平台返回状态与时间；
7. 在“网站分析”观察抓取和收录，在“消息中心”看错误通知。

站点使用同 URL 响应式 HTML，不需要另交移动域名适配关系。`robots.txt` 应允许 UA `yisouspider` 抓取公开页。神马是移动搜索，重点抽查窄屏排版、字体、CTA 可点击区域、首屏速度和无横向滚动。

如果平台报格式问题或没有 sitemap 权限，可联系 `sm-service@service.alibaba.com`；官方帮助页也列有钉钉群 21988361、23167495。不要把“数据开放”当作普通 sitemap 的替代入口，除非平台另行确认合作资质和数据协议。

## 8. 上线后 14 天操作节奏

| 时间 | 操作 |
|---|---|
| D0 | 部署；跑第 3 节全部门禁；保存 sitemap 哈希、URL 数和抽样结果；不提交有错误的平台 |
| D1 | 360、神马提交 `sitemap-cn.xml`；检查搜狗资质与邀请；百度提交静态 sitemap 与 `0001` |
| D2～D3 | 查看平台 sitemap 状态与抓取诊断；修复 4xx/5xx、robots、XML 或响应速度问题 |
| D7 | 记录四家索引量、抓取量、关键词/流量、异常；人工抽查搜索结果标题、摘要与落地页 |
| D8～D14 | 只修真实问题，不反复提交；百度首片正常后补齐当次生产叶子 |
| D14 | 对比 D7 数据，决定是否开启百度“当天新增 URL”API 推送；形成第一版收录基线 |

建议操作台账至少包含：平台、站点、提交账号、提交文件、提交时间、平台状态、最近抓取时间、发现 URL 数、索引量、错误、处理人和复查日期。

## 9. 异常与下线

### 9.1 sitemap 失败

按以下顺序排查：

1. 公网 DNS、TLS、HTTP 状态和响应时间；
2. verification 是否仍有效；
3. robots 是否误拦；
4. XML 能否解析、命名空间是否正确；
5. 是否提交了 sitemap index 给百度；
6. 是否有神马叶子超过 10,000 URL 或顶层缺少 `lastmod`；
7. URL 是否属于已验证的准确协议与域名；
8. 页面是否软 404、自动跳 `.com`、noindex 或只有空壳；
9. 平台是否没有 sitemap 权限或已耗尽账号配额。

### 9.2 内容删除或投诉

1. 在内容审核端作 deny 决策；
2. 触发/等待同步删除；
3. 确认 `.cc` URL 返回 404 或 410；
4. 确认所有 sitemap 已移除该 URL；
5. 大批量删除时分别使用四家“死链提交”，不要把仍返回 200 的 URL 放入死链文件；
6. 保留投诉、决定、删除时间和平台提交记录。

### 9.3 不要做的操作

- 不要因收录慢而每天重复添加同一 sitemap；
- 不要把 `.com` 的 URL 放进 `.cc` sitemap；
- 不要提交工作台、API、登录、验证文件或搜索结果页；
- 不要把海外转载/翻译内容描述成拥有原文版权的“完全原创”；
- 不要通过隐藏文本、自动跳转、关键词堆砌或伪造 `lastmod` 提升抓取；
- 不要删除四个验证文件；
- 不要在本次未获授权的情况下 push、部署或替用户点击最终提交按钮。

## 10. 官方资料

- [百度普通收录](https://ziyuan.baidu.com/linksubmit/index)
- [百度普通收录使用手册：API、手动、sitemap 与索引型文件限制](https://ziyuan.baidu.com/college/courseinfo?id=267&page=2)
- [百度资源提交工具常见问题](https://ziyuan.baidu.com/college/articleinfo?id=3217)
- [360 站长平台 Sitemap 提交](https://zhanzhang.so.com/sitetool/sitemap)
- [搜狗 Sitemap 提交帮助](https://zhanzhang.sogou.com/index.php/help/sitemap)
- [搜狗网站验证与资质说明](https://zhanzhang.sogou.com/index.php/help/siteVerify)
- [神马 Sitemap 格式说明](https://zhanzhang.sm.cn/open/helpsitemap)
- [神马移动网站优化指南](https://zhanzhang.sm.cn/open/optimizaGuide)
- [神马站长平台帮助与反馈方式](https://zhanzhang.sm.cn/open/help)

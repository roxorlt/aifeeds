# Round 5 验收:播客分享海报重新布局 + capture 重叠修复

> 2026-06-18 | 分支 `feat/blog-podcast-sources` | 环境 staging
> 触发:PM 对真实分享海报的 5 条反馈(右上角源标签、文字重叠、整体重排)。
> 执行约定:用 modern-screenshot 实际 capture 出 PNG 验证(而非实时 DOM),问题修完才交付。

## 一、PM 反馈与对应改动

| # | 反馈 | 改动 |
|---|------|------|
| 1 | 播客海报右上角源标签应只保留「播客」两字 | `PosterCanvas` SOURCE_LABELS:podcast `官方新闻 · 播客` → `播客`(blog 仍「官方新闻」) |
| 2 | 文字重叠(主持人名字右边过早折行) | 根因是 modern-screenshot 截图时 **flex 行内换行文字高度算错、压到下一兄弟**;改用 inline/block 流重排所有含换行文字的行 |
| 3.1 | 封面左,右侧=标题、主持、嘉宾、音频时长 | PodcastCard posterMode 重写:header 区(封面左 + 右栏 标题/主持/嘉宾/收听播客徽标) |
| 3.2 | 其下=抽屉「节目简介」文案,左对齐到封面左边 | header 下方全宽「节目简介」区(用 shownotes 原文/中译,与抽屉一致);列表剥了 shownotes,故让 ShareDialog 拉完整 item |
| 3.3 | 再下=「话题脉络」,海报高度非固定自适应 | 全宽「本期话题脉络」区,**全部节点**(时间+主题+观点),海报高度随内容自适应 |

## 二、关键技术点

1. **重叠根因(modern-screenshot / foreignObject)**:截图把 DOM 克隆进 `<foreignObject>` 重排,字体度量有亚像素差异,**正好卡在换行边界的文字**会在克隆里多折一行,但容器高度还是按原 DOM 单行算的 → 多出的那行压到下一个兄弟元素。实时 DOM 截图(playwright)看不到,只有走 capture 才暴露。
   - **修复**:posterMode 里主持/嘉宾/节目名/时间轴一律 inline/block 正常流(图标 `inline-block` + `align-middle`),不用 `flex` 包裹换行文字;节目简介/话题脉络改全宽(不再挤在封面右侧窄列,从源头减少折行)。
2. **海报需要完整 item**:列表 API 把 `shownotes`/`shownotes_zh` 等重字段剥了(`LIST_HEAVY_EXTRA_KEYS`),而分享流程传给海报的就是列表瘦 item → 节目简介拿不到。`ShareDialog` 开启时 `fetchItem(id)` 拉完整 item,拉到前用列表 item 兜底(timeline/hosts 等轻字段列表已有),截图 effect 等 `posterItemReady` 再触发。
3. **流内卡片不变**:posterMode 与流内态彻底分成两个 return 分支,共用封面/取数逻辑;流内仍是 TweetCard 家族(封面左 + 标题/摘要/时长),海报元素零泄漏。

## 三、验收用例(staging 实测,均用 capture 出的真实 PNG 复核)

| # | 用例 | 预期 | 结果 |
|---|------|------|------|
| P1 | 标准播客海报(MCP×K8s,12 节点,有真嘉宾) | 新版式;无任何文字重叠;主持/嘉宾/节目名完整不截断;话题脉络全节点 | ✅ 主持「Chris Benson、Daniel Whitenack」单行不压、嘉宾「Craig McLuckie」干净、节目名「Practical AI」完整;12 节点时间+主题+观点全渲染无重叠 |
| P2 | 源标签 | 右上角「播客」两字 | ✅ |
| P3 | 版式结构 | 封面左 + 右栏(标题/主持/嘉宾/收听播客徽标);其下节目简介全宽;再下话题脉络全宽 | ✅ 三段式与反馈一致;节目简介左对齐到封面左边 |
| P4 | 节目简介内容 | 抓取的 shownotes 原文/中译(与抽屉「节目简介」同源),非概览 | ✅ 显示「当 AI 代理不再像聊天机器人…」译文 shownotes |
| P5 | 嘉宾去重(Zero Trust,guests==hosts) | 只显主持行,无嘉宾行 | ✅ |
| P6 | 无时间轴播客(Gradient Dissent) | 优雅省略话题脉络区;header + 节目简介正常;无报错 | ✅ 只有 header(嘉宾 Arvind Jain,无主持也正常)+ 节目简介 |
| P7 | 海报高度自适应 | 高度随话题脉络长度变化(非固定) | ✅ Zero Trust 12 短观点节点≈中等高;MCP 12 长观点节点更高,均完整不裁切 |
| P8 | 流内卡片回归 | 封面+节目名+时间+标题+摘要+时长(时钟);无徽标/主持嘉宾/话题脉络/节目简介泄漏 | ✅ DOM 扫描 4 项泄漏均 false;视觉正常 |
| P9 | blog 海报回归 | 不受影响;chip「官方新闻」;标题/摘要/缩略图/阅读时长齐 | ✅ |
| P10 | 完整 item 拉取 | ShareDialog 拉完整 item 后再截图,节目简介有值 | ✅ 调试路由走同一 fetchItem+PosterCanvas 路径验证;ShareDialog 逻辑等价接线 |
| P11 | TS 编译 | dashboard build 无 error | ✅ |

## 四、说明 / 待 PM 定夺

- **海报高度**:按反馈 #3.3「自适应」,话题脉络展示**全部节点 + 完整观点**,12 节点长观点的会比较高(可正常滚动浏览,不裁切)。若 PM 觉得过长,可一行改为「只显时间+主题(去掉观点段)」约减半高度 —— 当前按"忠实展示那部分文案"实现。
- **登录态真实分享流程**:海报渲染走 `fetchItem` + `PosterCanvas`,与调试路由完全同一路径;ShareDialog 的完整-item 拉取为等价接线。OTP 自动登录被安全策略禁止,真实「分享」按钮请 PM 在 staging 登录后点一下终验。

## 五、PM 验收指引(staging)

1. 登录 staging → 打开任意播客抽屉 → 点「分享」看海报(重点:右上角「播客」、无文字重叠、三段式版式)
2. 重点样本:
   - 标准:`/o/podcast:practical-ai:78c8093da8eafe94`(MCP×K8s,有嘉宾 + 长话题脉络)
   - 去重:`/o/podcast:practical-ai:a23a8cbbad9a9ab3`(Zero Trust,只主持无嘉宾)
   - 无轴:`/o/podcast:gradient-dissent:9a0c649692234b6c`(只 header + 简介)

## 六、结论

11 条用例全部通过。核心反馈(源标签、文字重叠、三段式重排、自适应高度)全部落实,并修复了"海报拿不到 shownotes"的数据链路问题。blog 海报与流内卡片无回归。调试路由 `/__poster/:id` 验证后已删除。

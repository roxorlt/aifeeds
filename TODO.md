# xList TODO

## 进行中
- [ ] enricher daemon: L0-L5 分层 metrics 刷新，按热度衰减调度
- [ ] cron 自动补全: 抓取后在 push_to_cloud 前自动补 quote + card + 翻译（main.py run()）

## 待做
- [ ] Dashboard P1: dark mode、keyword 噪音审核面板、smart text truncation
- [ ] 引用 + 被引用 feed 去重策略（同一条被 quote 又独立出现）
- [ ] 前端 on-demand metrics 刷新（Worker /api/refresh/:id + 前端曝光触发）
- [ ] 关键词自学习优化: LEARNED_MIN_HITS 3→8、mid-sentence capitalization only、seed 共现

## 已完成
- [x] Dashboard P0: 骨架屏、error retry、hashtag/URL 高亮、image lightbox、mobile 优化、thread 聚合
- [x] 卡片 X 样式对齐: 头像 40px、15px 字号、SVG verified 徽章、metrics 图标 + hover
- [x] Infinite scroll（IntersectionObserver + cursor 分页）
- [x] Thread 排序修复（snowflake tiebreaker）
- [x] 引用推文嵌套卡片（QuotedTweet 组件 + 图片去重）
- [x] Link card 组件（LinkCard 缩略图+标题+描述）
- [x] enrich_from_syndication.py: 6063 quote + 1989 card + 5430 翻译
- [x] WAL mode + thread 检测校准

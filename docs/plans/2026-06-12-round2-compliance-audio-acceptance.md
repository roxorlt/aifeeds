# 二轮改动验收用例(合规过滤 + 海报/空格/音频R2/占位)

> 日期:2026-06-12 ｜ 环境:staging ｜ 范围:涉华敏感合规 + 二轮验收 4 项修复
> 背景:用户问「你自己写测试用例测过每一个改动了吗」——此前为即兴逐项验证,本文档补上系统化用例并全量执行。
> **自查抓出 1 个严重缺口当场修复**(R1.1):合规判定原只挂 borderline 复判,高置信 relevant 内容跳过 → 已改为 step4 无条件必经 + 纳入完整性 gate。
> 结论:**19/19 通过**(2 条非阻塞瑕疵记录在案)。

## R1 涉华敏感合规(6 条)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| R1.1 | **新内容每条必经判定** | 完整 pipeline 跑完后 cn_sensitive 非 NULL | ⚠️→✅ **自查抓出缺口**:判定原挂在 `if(!highConfidentRelevant)` 的复判里,高置信内容跳过(裸奔到手动回填)。修复:step4 fan-out 加无条件 `classify-cn-sensitive` step + 判定失败不写完整性 gate(NULL 会被下发当通过)。端到端验证:清一条已完成条目的字段 → backfill 重触发完整 pipeline → `cn_sensitive=0` + wc_at 写回 ✅ |
| R1.2 | 命中内容拦截 | 列表不含 + 单条 404 | ✅ 用户指出的 `blog:openai:2787087943490465`(PRC influence)被判 1;列表 100 条不含、单条 HTTP 404 |
| R1.3 | 误杀率审计 | 旗标内容确属涉华敏感 | ✅ 834 条全量判定,**旗标 7 条(0.8%)**:PRC influence / Lex 中国政治 ×2 / 共产主义毛泽东 / Vivek 民族主义 / Amodei 谈 DoW / 蒸馏攻击(涉 DeepSeek 指控叙事,边界偏保守符合「宁可错杀」)。无明显误杀 |
| R1.4 | 判定失败不放行 | cn_sensitive=null → 不写 wc_at → backfill 自愈 | ✅ 代码断言(gate `sens.cn_sensitive !== null`)+ R1.1 端到端含此路径 |
| R1.5 | 存量回填收敛 | 全部 relevant 判定完毕 | ✅ `cn_left=0`(834/834),后台 loop 自动收敛停止 |
| R1.6 | reasoning 模型 maxTokens | 判定调用不被思维链截断 | ⚠️→✅ **踩坑**:deepseek-v4-flash 思维链计入 completion tokens,maxTokens 30/80 大面积 `finish_reason=length`(0/10 全失败)。统一提至 gate 300 / 复判 300 / 合规 500 后 15/15 全过 |

## R2 分享海报(3 条)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| R2.1 | FE PosterCanvas(分享面板卡片) | 不再「暂不支持该来源」 | ✅ podcast 抽屉点分享,提示语消失、sheet 正常 |
| R2.2 | 后端 SVG 海报 blog | /api/share/poster 渲 PNG | ✅ 伪造 token 实测 HTTP 200,1080×1475 PNG;目检:标题中译 + ELI25 摘要 + monogram + 阅读时长 + QR 全对。⚠️ 非阻塞瑕疵:该条封面取失败时顶部留了空白灰框(设计应跳过媒体块),记 TODO |
| R2.3 | 后端 SVG 海报 podcast | 同上 | ✅ HTTP 200,1080×1154 PNG;目检:orchid「AI 播客」chip + 真专辑封面 + SVG 时钟 + 时长 47:02,零 emoji |

## R3 空格控播(3 条)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| R3.1 | 空格 = play/pause | 不再穿透滚动 feed | ✅ keydown 派发:`defaultPrevented=true`(不滚动)+ audio paused 状态翻转(toggle 生效) |
| R3.2 | 表单/按钮豁免 | 聚焦按钮时空格不抢播放 | ✅ 聚焦「原文」按钮派发空格:audio 保持 paused + 未 preventDefault(原生行为保留) |
| R3.3 | 无 audio 安全 | 无播放器抽屉按空格不报错 | ✅ audioRef null 守卫(代码断言 + 图文条目页无 console error) |

## R4 音频迁 R2(5 条)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| R4.1 | 迁移成功率 | 流式直传无 OOM | ✅ 后台 loop 365+ 条迁完,批次 100% 成功(3/3 ×多轮),剩 116 条收敛中 |
| R4.2 | /r/ Range 206 | seek 可用 | ✅ `bytes=0-1023`→206/1024B、1MB 处→206/1000B、`accept-ranges: bytes` |
| R4.3 | FE 走 R2 + preload=none | src 为 staging-api/r/podcast-audio/… | ✅ 实测 src 已切 R2、preload=none、打开抽屉音频 CDN 0 请求、旧文案已删 |
| R4.4 | skip 分支 | 超大/无长度保留原链 | ✅ 真实数据:1 条 `too-large`(Lex 3 小时 >250MB)按设计跳过 |
| R4.5 | 原链兜底 | 未迁条目播放器仍工作 | ✅ Lex too-large 条目播放器 src=blubrry 原链,正常渲染 |

## R5 无音频占位(2 条)

| # | 用例 | 预期 | 实测 |
|---|------|------|------|
| R5.1 | 图文 newsletter 占位 | 「本期为图文内容,无音频」 | ✅ latent-space d8e2054a 实测显示占位、无空 audio 元素 |
| R5.2 | 有音频不显占位 | 正常播放器 | ✅(R4.3 同条验证) |

## 非阻塞瑕疵(记录)

1. blog 海报封面取失败时顶部留空白灰框(应跳过媒体块)——`renderBlogContent` 媒体块条件待修,不影响信息表达。
2. 音频回填剩 ~116 条由后台 loop 自动收敛(~15 分钟),完成后 audio_left 应为 0+少量 skip。

## 工程教训(写给下一轮)

- **「改了组件」≠「改了行为」**:preload 第一次改在没人消费的 AudioPlayer 组件上(D4 用例抓出);本轮 PosterCanvas(前端)与 svg-template(后端)是两条独立海报链路,都要验。
- **「有判定逻辑」≠「每条都经过」**:合规判定挂在条件分支上即覆盖缺口(R1.1)。合规类逻辑必须无条件 + 纳入 gate。
- **reasoning 模型的 maxTokens 含思维链**(R1.6),配小必截断。

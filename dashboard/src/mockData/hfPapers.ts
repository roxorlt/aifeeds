// HF Daily Papers — Phase 0 mockup 假数据
//
// 来源：BE branch worktree-be-hf-import-design 下 sample 真实 HF API 响应
// （`docs/plans/_research/2026-05-18-hf-daily-papers-sample/paper_detail_*.json`）
// 覆盖 upvote 分布 / GH 关联三种状态。
//
// title_zh / summary_zh / ai_summary_zh / deep_analysis 全部 FE mockup
// 手写编造（BE Phase 4 由 DeepSeek pro 自动生成），仅用于演示卡片 / 抽屉视觉。
//
// 上线时这个文件随同 mockup 路由一起删除（mock 数据不进 prod）。

import type { Item } from "../types";

// HF 提交人 avatar 有两种格式：
//   1. 完整 URL：https://cdn-avatars.huggingface.co/v1/production/uploads/...
//   2. SVG identicon 兜底相对路径：/avatars/<hash>.svg（HF 不上传头像时）
// 这里统一拼成绝对 URL，BE Phase 1 会写规范化逻辑（拼 huggingface.co host
// + /img 反代 allowlist），mockup 阶段直拉 CDN 即可。
function normalizeAvatar(raw: string): string {
  if (raw.startsWith("/avatars/")) return `https://huggingface.co${raw}`;
  return raw;
}

function thumbnail(arxivId: string): string {
  return `https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/${arxivId}.png`;
}

export const MOCK_HF_PAPERS: Item[] = [
  // 1. 高 upvote(140) + 有 GH(70 stars) + 28 作者
  {
    id: "hf:2605.13301",
    source_type: "hf_paper",
    source_id: "2605.13301",
    title: "Achieving Gold-Medal-Level Olympiad Reasoning via Simple and Unified Scaling",
    content:
      "Recent progress in reasoning models has substantially advanced long-horizon mathematical and scientific problem solving, with several systems now reaching gold-medal-level performance on International Mathematical Olympiad (IMO) and International Physics Olympiad (IPhO) problems. In this paper, we introduce a simple and unified recipe for converting a post-trained reasoning backbone into a rigorous olympiad-level solver.",
    content_translated:
      "近期推理模型在长时程数学与科学问题求解上有显著进展，多个系统已在国际数学奥赛 (IMO) 与国际物理奥赛 (IPhO) 上达到金牌级表现。本文提出一套简洁统一的方案，将已 post-train 的推理 backbone 转化为严密的奥赛级求解器。",
    author: "Yafu Li",
    handle: "yaful",
    url: "https://huggingface.co/papers/2605.13301",
    published_at: "2026-05-13T00:00:00.000Z",
    scraped_at: "2026-05-15 08:00:00",
    is_relevant: 1,
    media: [{ type: "image", url: thumbnail("2605.13301") }],
    metrics: { upvotes: 140, num_comments: 13, github_stars: 70 },
    extra: {
      arxiv_id: "2605.13301",
      arxiv_categories: ["cs.LG", "cs.AI", "math.OC"],
      title_zh: "通过简洁统一的扩展方案达成奥赛金牌级推理",
      summary_zh:
        "近期推理模型在长时程数学与科学问题求解上有显著进展，多个系统已在 IMO 与 IPhO 上达到金牌水平。本文提出一套简洁统一的方案，将已 post-train 的推理 backbone 转化为严密的奥赛级求解器：先用反向困惑度课程做 SFT 灌输严密的证明搜索与自检行为，再用两阶段 RL 流水线（可验证奖励 RL → 细化的证明级 RL）放大这些行为，最后用测试时扩展提升求解性能。基于此训练的 30B-A3B 模型 SU-01 支持 100K+ token 的稳定推理，在 IMO 2025 / USAMO 2026 / IPhO 2024-2025 上达成金牌级表现。",
      ai_summary_zh:
        "一套系统化方法通过反向困惑度课程、两阶段强化学习与测试时扩展，将 post-train 推理模型升级为严密的奥赛级求解器，在数学与物理竞赛上拿到金牌成绩。",
      ai_keywords: [
        "推理模型",
        "数学问题求解",
        "强化学习",
        "反向困惑度课程",
        "测试时扩展",
        "可验证奖励",
        "证明级 RL",
      ],
      submitted_by: {
        user: "yaful",
        name: "yaful",
        fullname: "Yafu Li",
        avatar_url: normalizeAvatar("/avatars/e986a2a6625e7be6890616a417f908d2.svg"),
        is_pro: false,
      },
      submitted_on_daily_at: "2026-05-15T00:00:00.000Z",
      project_page: "https://simplified-reasoning.github.io/SU-01",
      github_repo: "https://github.com/Simplified-Reasoning/SU-01",
      github_stars: 70,
      arxiv_pdf_url: "https://arxiv.org/pdf/2605.13301.pdf",
      ar5iv_html_url: "https://ar5iv.org/abs/2605.13301",
      discussion_id: "6a05351fb1a8cbabc9f0874b",
      paper_authors: [
        { name: "Yafu Li" },
        { name: "Runzhe Zhan" },
        { name: "Haoran Zhang" },
        { name: "Shunkai Zhang" },
        { name: "Yizhuo Li" },
        { name: "Zhilin Wang" },
        { name: "Jiacheng Chen" },
        { name: "Futing Wang" },
        { name: "Xuyang Hu" },
        { name: "Yuchen Fan" },
        { name: "Bangjie Xu" },
        { name: "Yucheng Su" },
        { name: "Xinmiao Han" },
        { name: "Chenxi Li" },
        { name: "Haodi Lei" },
        { name: "Yufeng Zhao" },
        { name: "Zejin Lin" },
        { name: "Qianjia Cheng" },
        { name: "Tong Zhu" },
        { name: "Xiaoye Qu" },
        { name: "Ganqu Cui" },
        { name: "Peng Ye" },
        { name: "Yun Luo" },
        { name: "Zhouchen Lin" },
        { name: "Yu Qiao" },
        { name: "Bowen Zhou" },
        { name: "Ning Ding" },
        { name: "Yu Cheng" },
      ],
      full_text_zh: null,
      discussion_fetched_at: "2026-05-15T08:30:00.000Z",
      discussion_comments: [
        {
          id: "mock-c-001",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Sebastien Rivera",
          author_handle: "srivera-rl",
          content:
            "The two-stage RL (verifiable rewards → proof-level rewards) is the key insight here. We tried jumping straight to proof-level RL last year and the training was completely unstable — reward signal too sparse, model collapsed to high-variance gibberish. The curriculum-style transition makes total sense in hindsight.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "**两阶段 RL** 这里是关键洞见。我们去年试过直接上 proof-level RL,训练完全不稳定 —— 奖励信号太稀疏,模型崩溃成高方差的乱码。课程式过渡现在回头看完全合理。",
          posted_at: "2026-05-14T10:23:00.000Z",
          like_count: 23,
          reactions: [{ emoji: "👍", count: 23 }],
        },
        {
          id: "mock-c-002",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Yafu Li",
          author_handle: "yaful",
          content:
            "@srivera-rl Thanks! Yes that's exactly why we landed on this structure. Initial experiments showed proof-level RL needs a strong prior — verifiable RL gives that. We're working on a distilled 7B version, should bring training cost down ~5x. Stay tuned.",
          content_html: "",
          is_author_reply: true,
          language: "en",
          content_zh:
            "@srivera-rl 谢谢!对,这就是我们选这个结构的原因。初步实验显示 proof-level RL 需要强 prior —— verifiable RL 提供了这个。我们在做一个蒸馏版 7B,训练成本应该能降 ~5x。敬请关注。",
          posted_at: "2026-05-14T14:18:00.000Z",
          like_count: 41,
          reactions: [{ emoji: "👍", count: 41 }],
        },
        {
          id: "mock-c-003",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Math Olympiad Coach",
          author_handle: "imo-coach",
          content:
            "Question from a math olympiad coach perspective: how do you handle cases where the model produces a valid proof but with non-standard notation? Our human graders often deduct points for that even if the proof is correct.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "从数学奥赛教练角度问个问题:模型如果产出有效证明但用了非标准记号,你们怎么处理?我们人工 grader 经常因此扣分,即使证明是对的。",
          posted_at: "2026-05-14T16:45:00.000Z",
          like_count: 12,
          reactions: [{ emoji: "👍", count: 12 }],
        },
        {
          id: "mock-c-004",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Engineering User",
          author_handle: "eng-replicator",
          content:
            "Replicated the full pipeline on 8x H100. SFT + RL took ~5 days, benchmarks within ±1.5% of paper numbers. Excellent reproducibility. One note: the reverse_ppl scoring model is the bottleneck for SFT data prep, took ~12 hours alone on 8x H100. Maybe worth caching scored datasets for community.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "在 8x H100 上复现了完整 pipeline。SFT + RL 花了 ~5 天,benchmark 数字在论文 ±1.5% 之内。复现质量很好。一个备注:`reverse_ppl` 判分模型是 SFT 数据准备的瓶颈,单独 12 小时跑在 8x H100。也许值得为社区缓存已打分数据集。",
          posted_at: "2026-05-15T03:20:00.000Z",
          like_count: 18,
          reactions: [{ emoji: "👍", count: 18 }],
        },
        {
          id: "mock-c-005",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "AI Safety Researcher",
          author_handle: "safety-watch",
          content:
            "Curious about the catastrophic forgetting issue mentioned in Appendix D — MMLU drops 2.1% post-training. Is this acceptable for production use? For a 'general reasoning assistant', a 2% drop on general knowledge might add up across domains.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "好奇 Appendix D 提到的 catastrophic forgetting 问题 —— 训练后 MMLU 掉 2.1%。这在生产可接受吗?对'通用推理助手'来说,2% 一般知识的下降叠加到多个域可能很显著。",
          posted_at: "2026-05-15T07:12:00.000Z",
          like_count: 9,
          reactions: [{ emoji: "👍", count: 9 }],
        },
      ],
      deep_analysis: {
        tldr:
          "提出一套**简洁统一的奥赛级推理 recipe**:反向困惑度课程做 SFT 灌输严密证明搜索行为,两阶段 RL(可验证奖励 → 证明级奖励)放大行为,test-time scaling 解决长 trajectory 推理。基于 30B-A3B + 340K SFT + 200 RL 步训出的 **SU-01**,在 IMO 2025 / USAMO 2026 / IPhO 2024-2025 上稳定金牌水平,能输出 100K+ token 推理链路。recipe 核心价值是**统一性** —— 同 pipeline 适配数学与物理两个域,无需为每学科单独设计奖励。",
        problem:
          "当前推理模型在长时程证明任务上有三大痛点:\n\n**严密性不足**:o1 / DeepSeek-R1 类模型在数学/物理奥赛证明题上,推理链常有「看似合理但严密性破绽」 —— 代数证明跳步、关键引理未验证、case-by-case 分类不完整。自动评估难发现,但人工 grading 直接扣分。\n\n**自检能力弱**:模型生成完证明后,无法自我识别「刚才那步是不是错了」。即使有能力发现错误也不会回退修正,而是延续错误到底。\n\n**长 trajectory 不稳定**:奥赛证明常需 100K+ token,但已有模型在长 trajectory 出现「语义漂移」 —— 越往后越偏离初始目标,最后给出无关答案。\n\n这些痛点叠加,导致开源模型在奥赛 benchmark 稳定停留在银牌水平(IMO 2025 约 25% 通过率),金牌(前 8%)长期未被达到。",
        key_insight: [
          "本文最重要的洞见是 **把「严密性」当作可学习的训练信号,而不是事后过滤目标**。\n\n具体做法:\n\n1. 用独立判分模型为 SFT 候选轨迹打 `reverse_ppl` 分,代表「这条轨迹有多接近合理的证明结构」\n2. 按 `reverse_ppl` **升序**排课程(从最不合理到最合理),让模型逐步接触\n3. 类似 curriculum learning,但课程顺序信号来自「证明结构合理度」而非题目难度\n\n**两阶段 RL 衔接**是另一个关键:\n\n- **阶段 1**(可验证奖励 RL):用答案对错作奖励,模型先学会「产出正确答案」\n- **阶段 2**(证明级 RL):用判分模型对**证明过程**打分,学会「产出严密证明」\n\n两阶段过渡至关重要 —— 直接上证明级 RL 因奖励稀疏导致训练不稳定;单独用答案对错奖励则学不到严密性。",
        ],
        method:
          "**完整 pipeline:30B-A3B backbone + 三阶段训练 + test-time scaling**\n\n**基础模型**: 30B-A3B(混合专家架构,激活 3B 参数),作为推理 backbone。选 A3B 而非 dense 30B 是为 100K+ token 长 trajectory 保持低延迟。\n\n**训练流水线**:\n\n| 阶段 | 数据 | 目标 |\n|------|------|------|\n| SFT | 340K sub-8K-token trajectories,按 reverse_ppl 排课程 | 灌输严密证明搜索 + 自检行为 |\n| RL 阶段 1 | IMO / IPhO 历年题 + 可验证答案 | 答案级奖励 |\n| RL 阶段 2 | 同上 + 证明级判分模型 | 证明级奖励,200 RL steps |\n\n**Test-time scaling**: 推理时让模型采样多条 trajectory(每条最长 100K+ token),用 self-consistency + 判分模型选最佳证明。延迟换质量。\n\n**复现资源**: 训练代码 + 数据准备脚本 + RL pipeline + test-time scaling 配置全部在 GH 仓 `Simplified-Reasoning/SU-01` 公开。",
        experiments: {
          datasets: ["IMO 2025", "USAMO 2026", "IPhO 2024", "IPhO 2025"],
          key_metrics: [
            { name: "IMO 2025 排名", value: "Gold", vs_baseline: "前 8%" },
            { name: "USAMO 2026", value: "Gold", vs_baseline: "前 12%" },
            { name: "IPhO 2024/25 平均", value: "Gold", vs_baseline: "+~25%" },
          ],
          compute: "30B-A3B,8x A100 80G ~7 天",
        },
        industry_impact:
          "**三个维度的产业影响**:\n\n**科研工作流**: SU-01 可直接作「严密证明助手」 —— 研究者写论文时让模型代写定理证明初稿,再人工 review。比传统 LLM 写的「看似严密实则跳步」可靠得多。\n\n**AI 教学辅导**: 中学/大学数学物理竞赛培训场景。SU-01 可作「金牌教练」,生成包含完整推理链的解题示例,让学生学会「如何严密思考」,而非只是「如何得到答案」。\n\n**自动定理证明**: 与 Lean / Coq 等形式化证明系统对接 —— SU-01 生成自然语言证明草稿,形式化系统验证。可加速数学家形式化未被验证的经典定理。\n\n**统一 recipe 的延伸价值**: recipe 不绑定数学/物理,理论上可迁移到化学、生物等任何「有严密推理结构」的领域,只需替换 `reverse_ppl` 判分模型。",
        code_status: {
          narrative: "**完全开源 + 可复现 + 配置齐全**\n\n**GitHub 仓**: [`Simplified-Reasoning/SU-01`](https://github.com/Simplified-Reasoning/SU-01),**70+ ⭐**,Apache 2.0 license。\n\n已开源:\n\n- 训练代码(PyTorch + DeepSpeed,8x A100 80G)\n- SFT 数据准备脚本(含 `reverse_ppl` 判分模型)\n- 两阶段 RL pipeline(基于 verl 框架)\n- test-time scaling 推理配置\n- 7 个 benchmark 评估脚本(IMO 2025 / USAMO 2026 / IPhO 2024-2025 / AIME / MATH / GSM8K)\n\n**可复现性**: 论文 appendix B 详列所有超参数 + random seed。社区已有研究者 fork 复现,8x H100 上 ~5 天完成 SFT + RL 全流程,benchmark 数字误差 ±1.5%。\n\n**未开源**: 30B-A3B base model 权重未公开(需邮件申请,research 用途免费)。判分模型权重已公开。",
        },
        limitations: [
          "**三大局限 + 一个开放问题**\n\n**1. 训练成本高**: 30B-A3B + 340K SFT + 200 RL,8x A100 ~7 天,云端成本约 **$5,000-8,000**。对小团队 / 个人研究者仍是门槛。\n\n**2. 验证域有限**: 金牌成绩主要在 IMO/IPhO 4 数据集 + 7 benchmark 验证。化学、生物、CS 等其他奥赛级领域迁移性未充分验证。社区已有 issue 提出「为什么不顺便跑 IOI」,作者回复「算力预算用完了,留待社区」。\n\n**3. Test-time scaling 时延高**: 100K+ token 长 trajectory 推理,单次 5-10 分钟,不适合实时交互(如 ChatGPT 对话)。更适合「提交问题、稍后看结果」的异步场景。\n\n**开放问题**: 训练完成后,模型在「非奥赛级」日常推理任务是否出现 catastrophic forgetting?Appendix D 跑了 MMLU / GSM8K,结果略下降(**MMLU -2.1%**),但未深入分析。",
        ],
        novelty_rating: 4,
      },
      workflow_completed_at: "2026-05-15T08:00:00.000Z",
    },
  },
  // 2. 高 upvote(84) + projectPage 指向 GH 但 githubRepo 字段为 null + 9 作者
  {
    id: "hf:2605.15141",
    source_type: "hf_paper",
    source_id: "2605.15141",
    title:
      "Causal Forcing++: Scalable Few-Step Autoregressive Diffusion Distillation for Real-Time Interactive Video Generation",
    content:
      "Real-time interactive video generation requires low-latency, streaming, and controllable rollout. Existing autoregressive (AR) diffusion distillation methods cannot meet these constraints simultaneously.",
    content_translated:
      "实时交互视频生成需要低延迟、流式输出和可控展开。现有的自回归 (AR) 扩散蒸馏方法无法同时满足这些约束。",
    author: "Hongzhi Zhu",
    handle: "zhuhz22",
    url: "https://huggingface.co/papers/2605.15141",
    published_at: "2026-05-14T00:00:00.000Z",
    scraped_at: "2026-05-15 08:00:00",
    is_relevant: 1,
    media: [{ type: "image", url: thumbnail("2605.15141") }],
    metrics: { upvotes: 84, num_comments: 7 },
    extra: {
      arxiv_id: "2605.15141",
      arxiv_categories: ["cs.CV", "cs.LG"],
      title_zh: "Causal Forcing++:面向实时交互视频生成的可扩展少步自回归扩散蒸馏",
      summary_zh:
        "实时交互视频生成要求低延迟、流式输出与可控 rollout。已有的自回归扩散蒸馏方法无法同时满足这些约束。本文提出 Causal Forcing++,通过 causal consistency distillation + frame-wise autoregression + few-step AR initialization,在保持画质的同时把推理延迟降至 82ms/帧。",
      ai_summary_zh:
        "新的因果一致性蒸馏方法实现高效的帧级视频生成,相比已有方法显著降低延迟并提升质量,适用于实时交互场景。",
      ai_keywords: [
        "自回归扩散",
        "因果一致性蒸馏",
        "causal CD",
        "帧级自回归",
        "少步 AR 初始化",
        "实时视频生成",
      ],
      submitted_by: {
        user: "zhuhz22",
        name: "zhuhz22",
        fullname: "Hongzhi Zhu",
        avatar_url: normalizeAvatar("/avatars/d497a960f8aef6a974907b68ed750c1c.svg"),
        is_pro: false,
      },
      submitted_on_daily_at: "2026-05-15T00:00:00.000Z",
      project_page: "https://github.com/thu-ml/Causal-Forcing",
      github_repo: null,
      github_stars: null,
      arxiv_pdf_url: "https://arxiv.org/pdf/2605.15141.pdf",
      ar5iv_html_url: "https://ar5iv.org/abs/2605.15141",
      discussion_id: "mock-disc-15141",
      paper_authors: [
        { name: "Hongzhi Zhu" },
        { name: "Yifei Zhang" },
        { name: "Wenhao Chen" },
        { name: "Jianfei Cai" },
        { name: "Xiaowen Liu" },
        { name: "Bing Su" },
        { name: "Jun Zhu" },
        { name: "Bo Zhang" },
        { name: "Zelin Wang" },
      ],
      full_text_zh: null,
      discussion_fetched_at: "2026-05-15T08:30:00.000Z",
      discussion_comments: [
        {
          id: "mock-c-006",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Streaming Video Researcher",
          author_handle: "stream-diff",
          content:
            "82ms/frame is impressive but I'd like to see comparison with our recent StreamDiffusion work (CVPR 2026). The user preference 62% vs StreamDiff in your Table 3 — what version of StreamDiff? The latest v0.4 is much faster than the original.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "82ms/帧令人印象深刻,但我想看看跟我们最近的 StreamDiffusion 工作(CVPR 2026)的对比。Table 3 里 62% 用户偏好 vs StreamDiff —— 是哪个版本的 StreamDiff?最新的 v0.4 比原版快很多。",
          posted_at: "2026-05-14T11:30:00.000Z",
          like_count: 14,
          reactions: [{ emoji: "👍", count: 14 }],
        },
        {
          id: "mock-c-007",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Hongzhi Zhu",
          author_handle: "zhuhz22",
          content:
            "@stream-diff Fair point. We used StreamDiff v0.3 (Dec 2025) — v0.4 wasn't released when we ran experiments. Will update Table 3 in v2 with v0.4 numbers. Initial check shows our advantage shrinks to ~55% but still positive.",
          content_html: "",
          is_author_reply: true,
          language: "en",
          content_zh:
            "@stream-diff 公平。我们用的是 StreamDiff v0.3(2025 年 12 月) —— 跑实验时 v0.4 还没发。会在 v2 用 v0.4 数字更新 Table 3。初步检查显示优势缩到 ~55% 但仍为正。",
          posted_at: "2026-05-14T15:45:00.000Z",
          like_count: 22,
          reactions: [{ emoji: "👍", count: 22 }],
        },
        {
          id: "mock-c-008",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Game Engine Developer",
          author_handle: "unity-dev",
          content:
            "Interactive video gen for games is the holy grail. Question: is the 82ms inference on consumer GPUs feasible? Or is it 8x H100 only? We need ~30ms on RTX 4080 to be game-ready.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "游戏场景的交互视频生成是圣杯。问题:82ms 推理在消费级 GPU 上可行吗?还是只能 8x H100?我们需要 RTX 4080 上 ~30ms 才能玩游戏。",
          posted_at: "2026-05-15T02:18:00.000Z",
          like_count: 31,
          reactions: [{ emoji: "👍", count: 31 }],
        },
        {
          id: "mock-c-009",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Diffusion Theorist",
          author_handle: "theorist",
          content:
            "The causal consistency distillation is theoretically interesting — instead of trajectory-level consistency, you enforce per-step causality. Curious if this idea extends to text (e.g., distilling autoregressive LLMs for faster decoding).",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "**因果一致性蒸馏**在理论上很有意思 —— 不是 trajectory 级 consistency,而是 per-step causality。好奇这思路能否推广到文本(比如蒸馏自回归 LLM 加速解码)。",
          posted_at: "2026-05-15T05:42:00.000Z",
          like_count: 17,
          reactions: [{ emoji: "👍", count: 17 }],
        },
      ],
      deep_analysis: {
        tldr:
          "**因果一致性蒸馏 + 帧级 AR + 少步初始化**三件套组合,把实时视频生成做到 **82ms/帧**,蒸馏后模型可流式输出。核心创新是把蒸馏目标从「轨迹一致性」改为「因果一致性」,允许模型逐帧 + 少步生成而非整段 + 多步。WebVid-10M 上 FVD 112(-18),用户主观偏好 62%(vs StreamDiff v0.3)。让实时交互视频生成在场景上真正可行(直播虚拟主播 / 云游戏)。",
        problem:
          "现有 AR 扩散蒸馏方法在实时交互视频生成上有**三重 trade-off 困境**:\n\n**延迟问题**: 主流方法(如 StreamDiff、ConsistencyVDM)需要 200-500ms/帧推理,无法做到直播流畅度(需要 ≤100ms/帧达到 10+ FPS)。\n\n**流式不可行**: 部分高质量方法需要批量生成整段视频(如 5 秒一次性出),无法做「实时输入 → 实时输出」的交互场景。\n\n**质量崩塌**: 强行降步数(从 20 步降到 4 步)会导致严重的画质崩塌,FVD 飙升 50%+,无法商用。\n\n这三个 trade-off 让「实时交互视频生成」长期停留在 demo 阶段 —— 看起来 fancy 但无法部署到真实产品。本文目标是在保持画质的同时打破这三个 trade-off。",
        key_insight: [
          "本文最重要的洞见是 **把「因果一致性」作为蒸馏目标,而非「轨迹一致性」**。\n\n传统 consistency distillation(CD)要求学生模型在任意去噪步骤上跟教师模型的输出 trajectory 对齐。这隐含一个假设:整段视频是 batch 生成的,所有步骤同时优化。\n\n本文反过来想:**视频本质是因果序列**(t 帧只依赖 ≤t 帧),为什么蒸馏不利用这个 prior?于是把蒸馏目标改为:\n\n> 学生模型在「以前 N 帧为条件,生成下一帧」这个 sub-task 上,跟教师对齐。\n\n这一改动带来两个连锁好处:\n\n1. **可流式输出**: 模型天然支持帧级 streaming,不需要 batch 整段\n2. **可少步**: 因为只需对齐 sub-task 而非完整 trajectory,降步数(20→4)的画质损失小很多\n\n这也是论文标题「Causal Forcing++」的由来 —— `Causal Forcing` 是 2024 年的前作(把因果 prior 用在 training),本文把它延伸到 distillation。",
        ],
        method:
          "**完整 pipeline:三个组件叠加**\n\n**1. Causal CD(因果一致性蒸馏)** — 蒸馏目标改为帧级因果。教师模型用 20 步 DDPM,学生用 4 步,损失函数为 `L = E[||student(x_t | x_<t) - teacher(x_t | x_<t)||²]`,只在因果 sub-task 上对齐。\n\n**2. Frame-wise AR(帧级自回归)** — 推理时严格帧级自回归输出,允许模型 KV cache 复用前 N 帧,延迟从 batch 模式的 200ms+ 降到 82ms/帧。\n\n**3. Few-step AR initialization(少步 AR 初始化)** — 首帧用 8 步生成(质量优先),后续帧用 4 步(速度优先)。首帧质量决定整段视频走向,投资在第一帧的额外计算回报很高。\n\n**训练规模**: WebVid-10M 数据集,8x H100,~3 周训练。基模型是 OpenSora v2(已开源)。蒸馏后模型参数量不变,只是推理步数从 20 降到 4-8。",
        experiments: {
          datasets: ["WebVid-10M"],
          key_metrics: [
            { name: "FVD ↓", value: "112", vs_baseline: "-18" },
            { name: "推理延迟", value: "82ms/帧", vs_baseline: "-65%" },
            { name: "用户主观偏好", value: "62%", vs_baseline: "vs StreamDiff v0.3" },
          ],
          compute: "8x H100,~3 周训练",
        },
        industry_impact:
          "**直接打开 3 个产品场景**:\n\n**1. 直播虚拟主播**: 主播侧实时输入文本/动作 → 模型实时生成虚拟主播视频流。延迟 82ms 足够流畅,B 站 / Twitch 级别的虚拟主播直播成为可能。\n\n**2. 云游戏 AI NPC**: NPC 反应根据玩家动作实时生成视频片段,而不是预录素材。NPC 表现可以「千人千面」,极大提升沉浸感。RTX 4080 上能否跑到 30ms/帧是关键(社区评论已经在问)。\n\n**3. 交互式 AI 内容创作**: 设计师/导演实时调整提示词 → 视频立刻更新,所见即所得。比当前 \"提交 prompt 等 5 分钟看结果\" 的 workflow 高效得多。\n\n**生态影响**: 因果一致性蒸馏思路可扩展到其他自回归模型(文本 / 音频 / 3D)。社区已有讨论是否能用同样思路蒸馏自回归 LLM 加速解码。",
        code_status: {
          narrative: "**项目主页指向 GH 但 HF API 字段未识别**\n\n[`thu-ml/Causal-Forcing`](https://github.com/thu-ml/Causal-Forcing) — 项目主页就是 GH 仓地址,但 HF API 返回的 `githubRepo` 字段为 `null`(可能因为作者只填了 `projectPage` 字段)。BE 在 fetch 阶段需要做兜底:若 `projectPage` 是 GH URL,反推为 GH 仓 + 抓 star 数。\n\n**已开源**:\n\n- Causal-Forcing 训练代码(MIT license)\n- Pre-trained checkpoint(WebVid-10M 训练版)\n- Inference demo(单卡 H100 / A100 / 4090 兼容)\n\n**未开源**: 数据预处理 pipeline(涉及商用 WebVid-10M 授权数据,不可公开)。",
        },
        limitations: [
          "**已知三个局限**:\n\n**1. 分辨率天花板**: 当前验证仅到 720p,1080p+ 未实测。论文 ablation 暗示更高分辨率下 FVD 会上升约 8-12%,可能仍可接受但需要单独验证。\n\n**2. 长视频时序一致性**: 超过 30 秒的长视频生成会出现「角色漂移」(character drift)—— 主角的脸 / 服装在视频中后期慢慢变化。原因是帧级 AR 模型只看前 N 帧(N≤16),无法捕捉长期一致性。\n\n**3. StreamDiff 对比可能落后**: 评论区已指出对比的是 StreamDiff v0.3(2025-12),最新 v0.4 速度有显著优化。作者已承诺 v2 更新对比为 v0.4,但优势可能从 62% 缩到 ~55%。\n\n**开放问题**: 因果一致性蒸馏是否可迁移到非视觉的自回归模型(文本 LLM / 音频 / 3D)?目前论文 scope 限定在视频生成,但思路本身有更广泛的潜力。",
        ],
        novelty_rating: 3,
      },
      workflow_completed_at: "2026-05-15T08:00:00.000Z",
    },
  },
  // 3. 中 upvote(50) + 仅 projectPage 无 GH + 7 作者
  {
    id: "hf:2605.14386",
    source_type: "hf_paper",
    source_id: "2605.14386",
    title:
      "Darwin Family: MRI-Trust-Weighted Evolutionary Merging for Training-Free Scaling of Language-Model Reasoning",
    content:
      "We present Darwin Family, a framework for training-free evolutionary merging of large language models via gradient-free weight-space recombination.",
    content_translated:
      "我们提出 Darwin Family,一个通过梯度无关权重空间重组实现大型语言模型免训练进化合并的框架。",
    author: "Junhyung Park",
    handle: "seawolf2357",
    url: "https://huggingface.co/papers/2605.14386",
    published_at: "2026-05-14T00:00:00.000Z",
    scraped_at: "2026-05-15 08:00:00",
    is_relevant: 1,
    media: [{ type: "image", url: thumbnail("2605.14386") }],
    metrics: { upvotes: 50, num_comments: 4 },
    extra: {
      arxiv_id: "2605.14386",
      arxiv_categories: ["cs.LG", "cs.AI"],
      title_zh: "Darwin Family:基于 MRI 信任加权的免训练进化合并,扩展 LLM 推理能力",
      summary_zh:
        "提出 Darwin Family,一套通过梯度无关权重空间重组实现 LLM 免训练进化合并的框架。核心是 Merge Genome + MRI-Trust Fusion 两个机制 —— 前者把合并参数编码为可遗传基因,后者用 MRI 信任分配每层权重的融合系数,通过进化搜索找到最优合并配置。在 MMLU/GSM8K/HumanEval 上相比单基模型有 +5~+12% 收益。",
      ai_summary_zh:
        "Darwin Family 框架通过梯度无关权重空间重组实现 LLM 免训练进化合并,在多项推理 benchmark 上获得显著增益,适合算力受限团队组合开源模型。",
      ai_keywords: [
        "进化合并",
        "梯度无关权重空间重组",
        "merge genome",
        "MRI 信任融合",
        "信任参数",
        "免训练合并",
      ],
      submitted_by: {
        user: "seawolf2357",
        name: "seawolf2357",
        fullname: "Junhyung Park",
        // 真实 cdn-avatars 路径需要 auth header，直拉 403。mockup 用 HF identicon
        // 兜底（BE Phase 1 走 /img 反代后 cdn-avatars 域名进 PROXY_HOSTS 允许）。
        avatar_url: normalizeAvatar("/avatars/seawolf2357-mock-identicon.svg"),
        is_pro: true,
      },
      submitted_on_daily_at: "2026-05-15T00:00:00.000Z",
      project_page: "https://vidraft.net",
      github_repo: null,
      github_stars: null,
      arxiv_pdf_url: "https://arxiv.org/pdf/2605.14386.pdf",
      ar5iv_html_url: "https://ar5iv.org/abs/2605.14386",
      discussion_id: "mock-disc-14386",
      paper_authors: [
        { name: "Junhyung Park" },
        { name: "Soyeon Kim" },
        { name: "Daehoon Lee" },
        { name: "Wooseok Choi" },
        { name: "Jaehyun Kang" },
        { name: "Hyejin Yoon" },
        { name: "Minjoo Han" },
      ],
      full_text_zh: null,
      discussion_fetched_at: "2026-05-15T08:30:00.000Z",
      discussion_comments: [
        {
          id: "mock-c-010",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Model Merging Practitioner",
          author_handle: "merge-master",
          content:
            "We've been doing model merging for months with mergekit / Arcee. Question: how does your Merge Genome encoding compare to mergekit's YAML config? Is it strictly more expressive, or just a different abstraction?",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "我们用 mergekit / Arcee 做模型合并几个月了。问题:你们的 Merge Genome 编码跟 mergekit 的 YAML config 相比,是表达力更强,还是只是不同的抽象?",
          posted_at: "2026-05-14T09:15:00.000Z",
          like_count: 19,
          reactions: [{ emoji: "👍", count: 19 }],
        },
        {
          id: "mock-c-011",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Junhyung Park",
          author_handle: "seawolf2357",
          content:
            "@merge-master Strictly more expressive — Merge Genome supports per-layer trust weights (continuous values in [0, 1]) while mergekit YAML is mostly fixed weights or task-arithmetic discrete choices. The MRI-Trust Fusion is where we get the 5-13% boost over mergekit baselines.",
          content_html: "",
          is_author_reply: true,
          language: "en",
          content_zh:
            "@merge-master 严格上表达力更强 —— Merge Genome 支持 per-layer 信任权重(在 [0,1] 之间的连续值),而 mergekit YAML 主要是固定权重或 task-arithmetic 离散选择。**MRI-Trust Fusion** 是我们比 mergekit baseline 提升 5-13% 的关键。",
          posted_at: "2026-05-14T13:48:00.000Z",
          like_count: 28,
          reactions: [{ emoji: "👍", count: 28 }],
        },
        {
          id: "mock-c-012",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Reproducibility Concerned",
          author_handle: "repro-check",
          content:
            "Code not open-sourced is a red flag for me. The 8.6% average improvement is large and surprising — without code I can't verify the eval setup. Is this evolutionary search with a verification leak (e.g., evolving on test set)?",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "代码未开源对我是个 red flag。8.6% 平均提升又大又出乎意料 —— 没代码我无法验证 eval 设置。会不会是进化搜索时 leak 到测试集(比如在测试集上进化)?",
          posted_at: "2026-05-15T01:33:00.000Z",
          like_count: 35,
          reactions: [{ emoji: "👍", count: 35 }],
        },
      ],
      deep_analysis: {
        tldr:
          "**把 LLM 权重当 DNA**,用进化算法 + MRI 信任融合做**免训练**合并,3 项推理 benchmark(MMLU / GSM8K / HumanEval)平均提升 **8.6%**,完全不动梯度。核心是 `Merge Genome` 编码合并配置让进化算法替代梯度搜索,`MRI-Trust Fusion` 给每层独立融合权重避免重要层被噪声破坏。对算力受限小团队是低成本扩展开源 LLM 性能的可行路径,但代码未开源 + 评估方法学受社区质疑。",
        problem:
          "**模型微调成本高 + 现有合并方法有短板**\n\n微调一个 70B 模型到新任务通常需要 8x A100 跑 1-2 周,云端成本 $10K+,对小团队 / 算力受限场景门槛极高。\n\n现有的模型合并方法有几个痛点:\n\n**梯度依赖**: 多数 SOTA 合并方法(如 Task Arithmetic、TIES-Merging)需要每个候选合并配置上跑 fine-tune 梯度评估,本质还是需要 GPU 训练资源。\n\n**人工调参**: mergekit / mergetool 等工具虽不需梯度,但需要工程师手动调融合权重 / merge 策略,经验性强,效果不稳定。\n\n**层级粒度粗**: 多数方法对所有 transformer 层用同一融合系数,忽略了不同层重要性差异(attention layer 和 MLP layer 的合并策略应该不同)。",
        key_insight: [
          "本文两个核心洞见:\n\n**1. 把 LLM 权重当作可遗传的 DNA**\n\n传统进化算法在离散决策空间(如神经架构搜索)上工作。本文创新点是把**连续 weight space 的合并系数**编码为「Merge Genome」 —— 每层一组实数向量,定义如何融合多个 source model 的对应层权重。\n\n这让进化算法(crossover + mutation)可以直接在合并系数空间搜索,不需要梯度。\n\n**2. MRI-Trust 信任分配**\n\n受 fMRI 神经科学启发(分析每个脑区对认知任务的贡献),作者为每层计算一个 **trust value** —— 该层对最终输出的预测稳定性贡献。融合时高 trust 层用更保守的策略(避免破坏),低 trust 层允许更激进合并(寻找新增益)。\n\n这两个洞见结合,让进化搜索能在数十代内收敛到比梯度方法更好的合并配置。",
        ],
        method:
          "**完整 pipeline:进化搜索 + 信任评估**\n\n```\nMerge Genome 编码合并配置\n  ↓\n进化搜索(crossover + mutation)\n  ↓\nMRI-Trust Fusion 评估单代候选\n  ↓\n保留 top-k 进入下一代\n  ↓\n收敛或达到代数上限\n```\n\n**Merge Genome** 是核心数据结构:每个基因 = 一个合并配置,包含 N 层 × M 个 source model 的融合系数矩阵。基因长度约 1000-3000 个实数(取决于模型层数)。\n\n**MRI-Trust 计算**: 对每层 forward pass 一组 calibration data,记录该层输出的方差。低方差 = 高 trust(稳定贡献),高方差 = 低 trust(可塑性强)。\n\n**进化超参**: 种群大小 50,每代评估 50 个候选,跑 50 代,共 2500 次 forward pass。8x A100 上约 6-8 小时。\n\n**全程梯度无关** —— 这是与 task arithmetic 类方法的本质区别。",
        experiments: {
          datasets: ["MMLU", "GSM8K", "HumanEval"],
          key_metrics: [
            { name: "MMLU", value: "73.2", vs_baseline: "+5.1" },
            { name: "GSM8K", value: "82.4", vs_baseline: "+12.8" },
            { name: "HumanEval", value: "61.0", vs_baseline: "+7.9" },
          ],
          compute: "进化 50 代,8x A100 6-8h",
        },
        industry_impact:
          "**直接受益场景**:\n\n**小团队 / 算力受限**: 无需训练资源,基于已开源的 LLaMA / Qwen / Mistral 组合就能获得免训练增益。这套思路让初创公司 / 研究者 / 中小企业能用消费级 GPU(2x 4090)做模型合并,门槛从 $10K+ 降到 $0(只算电费)。\n\n**模型动物园 (Model Zoo) 价值放大**: 每个开源 base model 都不再是孤立资产,而是合并的 building block。Hugging Face Hub 上数千个 fine-tuned 模型可以通过 Darwin 系列方法组合出无数个新能力组合。\n\n**任务特化的快速迭代**: 传统 fine-tune 周期 1-2 周,进化合并 6-8 小时。产品团队可以快速试错不同任务的最优合并配置。\n\n**生态意义**: 让「LLM 民主化」更进一步 —— 不只是能用,还能定制。",
        code_status: {
          narrative: "**项目主页 [vidraft.net](https://vidraft.net) 上线 ⚠️ 代码未开源**\n\nBE Phase 4 部署时,deep_analysis prompt 必须**如实标注「未公开代码」**,严禁让 LLM 幻觉一个 GH 链接(这是 hallucination 高发场景)。\n\n**社区反馈**: HF discussion 已有 reproducibility check 评论(@repro-check)指出 8.6% 提升缺乏验证,作者尚未回应。如果 v2 仍不开源,可能被学术圈质疑。\n\n**已公开**: 项目主页有 demo(用预合并模型在 chat 界面展示)、技术 blog post、benchmark 数字截图。\n\n**未公开**: Merge Genome 编码代码、MRI-Trust 计算代码、进化搜索 pipeline、训练好的合并权重。",
        },
        limitations: [
          "**已知局限 + 开放问题**:\n\n**1. 强依赖优质基模型**: 进化搜索只能在已有 source models 的能力空间内搜索新组合。如果 source models 本身在某任务上都很弱,合并也救不回来。这限制了对完全新领域的扩展。\n\n**2. 进化搜索仍需时间**: 6-8 小时虽比 fine-tune 快,但跟一些用户的「instant merging」预期还有差距。50 代是经验值,某些任务可能需要 100+ 代。\n\n**3. 跨语言族合并收益降低**: 在中英文模型(如 Qwen + LLaMA)的合并上,MMLU 提升从 +5.1 降到 +2.3。可能因为不同语言的 token embedding 空间差异大,简单线性融合丢失信息。\n\n**4. 评估方法学受质疑**: 没有公开代码情况下,8.6% 平均提升让人怀疑评估有 leak(如在测试集上做进化搜索)。作者需要 v2 公开代码 + 评估 protocol 才能说服学术圈。",
        ],
        novelty_rating: 4,
      },
      workflow_completed_at: "2026-05-15T08:00:00.000Z",
    },
  },
  // 4. 中 upvote(21) + 有 GH(25 stars) + 3 作者
  {
    id: "hf:2605.06554",
    source_type: "hf_paper",
    source_id: "2605.06554",
    title: "Long Context Pre-Training with Lighthouse Attention",
    content:
      "Training causal transformers at extreme sequence lengths is bottlenecked by the quadratic time and memory of scaled dot-product attention (SDPA).",
    content_translated:
      "在极长序列上训练因果 Transformer 受限于 SDPA 二次时间与显存复杂度。",
    author: "Subho Ghosh",
    handle: "bloc97",
    url: "https://huggingface.co/papers/2605.06554",
    published_at: "2026-05-08T00:00:00.000Z",
    scraped_at: "2026-05-15 08:00:00",
    is_relevant: 1,
    media: [{ type: "image", url: thumbnail("2605.06554") }],
    metrics: { upvotes: 21, num_comments: 3, github_stars: 25 },
    extra: {
      arxiv_id: "2605.06554",
      arxiv_categories: ["cs.CL", "cs.LG"],
      title_zh: "Lighthouse Attention:面向长上下文预训练的层级选择注意力",
      summary_zh:
        "在极长序列上训练 causal transformer 受限于 SDPA 的 O(N²) 时间与显存复杂度。本文提出 Lighthouse Attention —— 一种层级选择型注意力机制,通过梯度无关的 token 重要性选择,把训练 100K+ token 上下文的开销降低 3 倍以上,且不损失下游性能。",
      ai_summary_zh:
        "Lighthouse Attention 利用层级选择型注意力实现因果 Transformer 长序列高效训练,把计算量降到与序列长度近似线性,同时保持下游任务性能。",
      ai_keywords: [
        "缩放点积注意力",
        "层级注意力",
        "因果 Transformer",
        "梯度无关",
        "序列长度",
        "长上下文预训练",
      ],
      submitted_by: {
        user: "bloc97",
        name: "bloc97",
        fullname: "Subho Ghosh",
        avatar_url: normalizeAvatar("/avatars/bloc97-mock-identicon.svg"),
        is_pro: false,
      },
      submitted_on_daily_at: "2026-05-12T00:00:00.000Z",
      project_page: "https://nousresearch.com/lighthouse-attention",
      github_repo: "https://github.com/ighoshsubho/lighthouse-attention",
      github_stars: 25,
      arxiv_pdf_url: "https://arxiv.org/pdf/2605.06554.pdf",
      ar5iv_html_url: "https://ar5iv.org/abs/2605.06554",
      discussion_id: "mock-disc-06554",
      paper_authors: [
        { name: "Subho Ghosh" },
        { name: "Karen Mathews" },
        { name: "Levi Hsu" },
      ],
      full_text_zh: null,
      discussion_fetched_at: "2026-05-15T08:30:00.000Z",
      discussion_comments: [
        {
          id: "mock-c-013",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Long Context Researcher",
          author_handle: "longctx",
          content:
            "How does this compare to Mamba-style state space models for long context? They also achieve sub-quadratic complexity. Is Lighthouse better at the same param/FLOP budget?",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "这跟 Mamba 类状态空间模型在长上下文上比怎么样?它们也达到亚二次复杂度。同 param/FLOP 预算下 Lighthouse 更好吗?",
          posted_at: "2026-05-12T22:30:00.000Z",
          like_count: 11,
          reactions: [{ emoji: "👍", count: 11 }],
        },
        {
          id: "mock-c-014",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Subho Ghosh",
          author_handle: "bloc97",
          content:
            "@longctx Good question — we have a small Mamba comparison in Appendix C. At 100K context, Mamba is ~1.8x faster than SDPA but Lighthouse is ~3.2x. The trade-off is that Mamba changes model architecture entirely, while Lighthouse is a drop-in replacement for SDPA in standard transformers. Different use cases.",
          content_html: "",
          is_author_reply: true,
          language: "en",
          content_zh:
            "@longctx 好问题 —— Appendix C 有小规模 Mamba 对比。100K 上下文下,Mamba 比 SDPA 快 ~1.8x,Lighthouse 快 ~3.2x。trade-off 是 Mamba 完全改变模型架构,而 Lighthouse 是标准 transformer 中 SDPA 的 drop-in 替换。不同 use case。",
          posted_at: "2026-05-13T09:18:00.000Z",
          like_count: 25,
          reactions: [{ emoji: "👍", count: 25 }],
        },
        {
          id: "mock-c-015",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Nous Research Engineer",
          author_handle: "nous-eng",
          content:
            "Tried this on our long-document RAG pipeline (avg 80K tokens). Training throughput matches the paper's claim. Quality on retrieval tasks is competitive with Flash Attention 3 within ±2%. Will deploy to production next month.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "在我们的长文档 RAG pipeline(平均 80K tokens)上试过。训练吞吐符合论文说的。在检索任务上的质量跟 Flash Attention 3 在 ±2% 之内。下个月部署到生产。",
          posted_at: "2026-05-14T16:42:00.000Z",
          like_count: 16,
          reactions: [{ emoji: "👍", count: 16 }],
        },
      ],
      deep_analysis: {
        tldr:
          "用「**灯塔节点**」分层选择注意力对象,把长序列 attention 从 O(N²) 降到近似 **O(N log N)**,训 100K token 上下文比标准 SDPA 快 **3.2x**。核心是把 token 分层组织,每层挑少量灯塔节点代表整层语义,下层只 attend 当前段 + 上层灯塔。在 The Pile / C4 上 100K token loss 降 0.08,Long Range Arena +1.2。**作为 SDPA drop-in 替换**,无需改模型架构,可直接用在已有 transformer 上。",
        problem:
          "**长上下文训练的 O(N²) 困境**\n\n标准 SDPA(Scaled Dot-Product Attention)二次复杂度让 100K+ token 上下文训练几乎不可行:\n\n**显存爆炸**: 注意力矩阵需要存 N×N,100K token 即 10GB 显存(fp16),8 个 transformer layer 就 80GB,超过单 H100 80G。\n\n**时间过长**: 100K token 单次 forward pass 约 30-60 秒,训练一个 epoch 需要数千 GPU-小时,成本不可接受。\n\n现有解决方案各有短板:\n\n- **Flash Attention**: 减少显存使用但不降复杂度,仍是 O(N²)\n- **稀疏注意力 (Sparse)**: 如 Longformer / BigBird,降复杂度但**在长程依赖任务上掉点 5-10%**(因为强制截断 attention 视野)\n- **滑窗注意力**: 完全丢失长程依赖,只能处理局部任务\n- **Mamba 类状态空间**: 改变模型架构,无法 drop-in 替换已有 transformer\n\n本文目标:**既降复杂度,又保留长程依赖能力,且可 drop-in 替换 SDPA**。",
        key_insight: [
          "**把 token 分层组织,引入「灯塔节点」代表整层语义**\n\n核心洞见来自现实生活的「灯塔」隐喻 —— 灯塔不需要被所有船只都看到,只要远处的船能看到它,就知道这片区域的位置。\n\n类比到 attention:\n\n1. **分层 token 组织**: 100K tokens 分成多个 segment,每个 segment 内部 dense attention(标准 O(M²))\n2. **灯塔选择**: 每个 segment 选少量「灯塔节点」(典型 5%),作为这段的语义代表\n3. **跨层 attention**: 下层 token 不直接 attend 远处所有 tokens,只 attend 当前 segment + 远处的灯塔\n\n这样:\n\n- **局部精细**: segment 内 dense attention 保留细节\n- **全局粗粒**: 灯塔节点提供全局上下文,代价小\n- **复杂度**: 总计算量 O(N · M + N · K) ≈ O(N log N)(K = 灯塔数,M = segment 大小)\n\n**灯塔选择策略**: 用**梯度无关的简单统计量**(token embedding 的 L2 norm 排序),不需要额外训练。",
        ],
        method:
          "**完整 pipeline:层级 token 划分 + lighthouse 选择 + 多层级 attention**\n\n```\n输入 100K tokens\n  ↓\n层级划分(L=3 层 segment 树)\n  ↓\nlighthouse 选择(每 segment 5% top-norm tokens)\n  ↓\n多层级 attention:\n  • 层 0: 每 segment 内 dense\n  • 层 1: cross-segment via 层 0 lighthouses\n  • 层 2: cross-supersegment via 层 1 lighthouses\n  ↓\n输出\n```\n\n**关键设计**:\n\n- **梯度无关 lighthouse 选择**: 不引入新参数 / 不需要训练新选择器,基于 token embedding 的简单 norm 排序\n- **与标准 transformer 兼容**: 可作 SDPA 的 drop-in 替换,已有模型直接热插拔\n- **causal mask 兼容**: 适配自回归训练,每个 token 只看到前 N 个灯塔\n\n**训练配置**: 8x A100 80G,batch 32,~3 天完成 The Pile + C4 联合训练。",
        experiments: {
          datasets: ["The Pile", "C4"],
          key_metrics: [
            { name: "训练吞吐", value: "3.2x", vs_baseline: "vs SDPA" },
            { name: "100K token loss", value: "2.14", vs_baseline: "-0.08" },
            { name: "Long Range Arena", value: "60.3", vs_baseline: "+1.2" },
          ],
          compute: "8x A100 80G,~3 天",
        },
        industry_impact:
          "**长上下文 LLM 训练成本大幅下降**\n\n直接受益场景:\n\n**小团队预训练**: 8 卡(8x A100 / H100)就能跑通 100K context 的 mid-size 模型(3B-7B)预训练,而非以前需要 64+ 卡。这让中小研究团队 / 创业公司能参与长上下文 LLM 研发,生态多元化。\n\n**长文档 RAG**: 检索增强生成(RAG)系统经常需要处理 50K+ token 的长文档上下文。Lighthouse 让推理也加速 ~3x,降低生产 RAG 系统的延迟和成本。社区已有评论(@nous-eng)反馈在 80K token RAG 上质量跟 Flash Attention 3 持平。\n\n**多模态长上下文**: 视频理解 / 长会议转录摘要等需要长 sequence 的多模态场景,Lighthouse 让 100K+ token 处理成为常规操作。\n\n**生态价值**: 因为是 drop-in 替换,已有的 LLaMA / Qwen / Mistral 等开源模型都能直接受益,无需重新设计架构。",
        code_status: {
          narrative: "**完全开源 + 25 ⭐ + 可复现**\n\n[`ighoshsubho/lighthouse-attention`](https://github.com/ighoshsubho/lighthouse-attention) 公开,**25 ⭐**,MIT license。\n\n已开源:\n\n- 训练代码(PyTorch,8x A100 80G 配置)\n- Lighthouse 选择实现(CUDA kernel + PyTorch fallback)\n- 推理示例(可直接替换 SDPA 调用)\n- 三个数据集预处理 + benchmark 脚本\n\n**复现成本相对低**: 训练规模较小(3B 模型 ~3 天),社区可负担。已有 ~5 个 fork 复现,benchmark 数字误差 ±3%。\n\n**未开源**: 极少量 fine-tune 实验的具体超参 / 检查点(论文 Table 5 的 instruction tuning 部分)。",
        },
        limitations: [
          "**已知三个局限**:\n\n**1. 仅 causal 场景验证**: 论文验证全部在 causal(自回归)transformer 上。encoder / 双向 attention 场景(如 BERT 类)未实验,理论上可行但需要修改 lighthouse 选择策略(因为双向 attention 没有「前后」概念)。\n\n**2. 极长程精细依赖未验证**: lighthouse 选择策略对超过 200K token 的极长程精细依赖任务效果未知。论文最长测试到 100K,200K+ 可能需要更深的 segment 树。\n\n**3. lighthouse 选择策略相对粗糙**: 当前用 token embedding norm 排序,这是经验性策略。可能存在「重要 token norm 不高」的边缘 case 被忽略。未来工作可探索 learnable lighthouse 选择。\n\n**开放问题**: 跟 Mamba 类状态空间模型的全面对比尚未充分。两者各有优势(Lighthouse drop-in / Mamba 架构纯净),未来应该有更系统的 benchmark 决定哪种长上下文方案更适合不同场景。",
        ],
        novelty_rating: 3,
      },
      workflow_completed_at: "2026-05-15T08:00:00.000Z",
    },
  },
  // 5. 低 upvote(1) + 无 GH 无 githubRepo + 仅 projectPage(冷启动 case)
  {
    id: "hf:2605.15320",
    source_type: "hf_paper",
    source_id: "2605.15320",
    title:
      "FFAvatar: Few-Shot, Feed-Forward, and Generalizable Avatar Reconstruction",
    content:
      "Avatar reconstruction has traditionally relied on per-subject optimization that requires hours of computation or on expensive preprocessing.",
    content_translated:
      "传统的虚拟形象重建方法依赖逐个体优化(需数小时)或昂贵的预处理流程。",
    author: "Taesiri",
    handle: "taesiri",
    url: "https://huggingface.co/papers/2605.15320",
    published_at: "2026-05-14T00:00:00.000Z",
    scraped_at: "2026-05-15 08:00:00",
    is_relevant: 1,
    media: [{ type: "image", url: thumbnail("2605.15320") }],
    metrics: { upvotes: 1, num_comments: 0 },
    extra: {
      arxiv_id: "2605.15320",
      arxiv_categories: ["cs.CV", "cs.GR"],
      title_zh: "FFAvatar:少样本、前向、可泛化的虚拟形象重建",
      summary_zh:
        "传统 Avatar 重建依赖逐个体优化(数小时计算)或昂贵预处理,限制了实时应用。FFAvatar 用前向 Multi-View Query-Former + FLAME 参数引导,从少量未姿态化图像端到端重建高质量 3D 高斯头像,单次推理只需 1.2 秒,比传统方法快数千倍且 PSNR 提升 2.1 dB。",
      ai_summary_zh:
        "FFAvatar 用前向多视角融合 + 端到端学习,从少量未姿态化图像快速重建高质量 3D 头像,大幅降低重建时间。",
      ai_keywords: [
        "前向框架",
        "3D 高斯头像",
        "Multi-View Query-Former",
        "FLAME 参数",
        "三阶段训练课程",
        "少样本重建",
      ],
      submitted_by: {
        user: "taesiri",
        name: "taesiri",
        fullname: "Taesiri",
        avatar_url: normalizeAvatar("/avatars/taesiri-mock-identicon.svg"),
        is_pro: true,
      },
      submitted_on_daily_at: "2026-05-15T00:00:00.000Z",
      project_page: "https://ffavatar.github.io/",
      github_repo: null,
      github_stars: null,
      arxiv_pdf_url: "https://arxiv.org/pdf/2605.15320.pdf",
      ar5iv_html_url: "https://ar5iv.org/abs/2605.15320",
      discussion_id: "mock-disc-15320",
      paper_authors: [
        { name: "Taesiri" },
        { name: "Aaron Chen" },
        { name: "Bo Wang" },
        { name: "Daria Petrova" },
        { name: "Elena Wong" },
        { name: "Felix Tanaka" },
      ],
      full_text_zh: null,
      discussion_fetched_at: "2026-05-15T08:30:00.000Z",
      discussion_comments: [
        {
          id: "mock-c-016",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "Taesiri",
          author_handle: "taesiri",
          content:
            "Just shared this on HF Daily — we're really excited about the speed (1.2s vs hours) without sacrificing too much quality. Demo is live on the project page, would love feedback!",
          content_html: "",
          is_author_reply: true,
          language: "en",
          content_zh:
            "刚分享到 HF Daily —— 我们对速度(1.2s vs 数小时)且不牺牲太多质量感到非常兴奋。Demo 在项目主页已上线,欢迎反馈!",
          posted_at: "2026-05-15T00:15:00.000Z",
          like_count: 5,
          reactions: [{ emoji: "👍", count: 5 }],
        },
        {
          id: "mock-c-017",
          author_avatar_url: "",
          is_pro: false,
          is_hf_admin: false,
          author_name: "VR Researcher",
          author_handle: "vr-curious",
          content:
            "1.2s per reconstruction is impressive for a single A100. What's the inference latency on consumer GPUs like RTX 4090? Real VR applications need sub-second on mid-tier hardware.",
          content_html: "",
          is_author_reply: false,
          language: "en",
          content_zh:
            "单 A100 1.2s 重建很快了。消费级 GPU 比如 RTX 4090 上推理延迟多少?真实 VR 应用需要中端硬件上亚秒级。",
          posted_at: "2026-05-15T03:30:00.000Z",
          like_count: 3,
          reactions: [{ emoji: "👍", count: 3 }],
        },
      ],
      deep_analysis: {
        tldr:
          "**前向 Multi-View Query-Former + FLAME 几何引导**,从少量未姿态化图像端到端重建 3D 高斯头像,**1.2 秒搞定** + PSNR +2.1dB。核心是用 Query-Former 做隐式视角融合 + FLAME 形变参数作几何 prior,模型学的不是单点重建而是「如何从少量观测推几何先验」。NeRSemble 上 4 张图重建质量超过传统 20+ 张图方法。**改写实时 avatar 重建可行性**,但代码未开源 + 极端表情/光照下细节仍有损失。",
        problem:
          "**传统 Avatar 重建的「不可能三角」**\n\n虚拟头像重建一直被三个相互冲突的目标困扰:\n\n**1. 重建时间**: 高质量方法(如 NeRSemble、PointAvatar、INSTA)需要逐个体优化 1-6 小时,无法实时部署到生产场景\n\n**2. 输入图像数量**: 高质量方法通常需要 20-100 张带精确相机姿态的图像作为输入,采集成本高 + 用户体验差\n\n**3. 重建质量**: 已有快速方法(如 NHA、EG3D)虽然推理快(<10s),但 PSNR 较 SOTA 低 3-5 dB,人物相似度肉眼可辨\n\n这三个目标长期不可兼得 —— 想要快 + 少图就得牺牲质量,想要高质量就得长时间 + 多图。这严重限制了 VR / 直播 / AR 等需要「实时 + 易用 + 高质量」的真实产品场景。\n\n**FFAvatar 目标**: 同时打破这三个 trade-off。",
        key_insight: [
          "**两个关键洞见**:\n\n**1. 用 Multi-View Query-Former 做隐式视角融合**\n\n传统多视角重建依赖**显式相机姿态**(SfM 或人工标定),这是耗时和需要专业设备的根因。FFAvatar 反其道而行,完全跳过显式 pose estimation —— 用 Query-Former 学习「从无姿态多视角图像隐式融合 3D 信息」的端到端能力。\n\nQuery-Former 输入 N 张未姿态化图像 + 一组可学习的 3D query tokens,输出每个 token 在 3D 空间的语义表示。这本质是把 pose estimation 隐式嵌入 transformer 注意力中。\n\n**2. FLAME 形变参数作几何 prior 注入**\n\n仅靠 Query-Former 隐式学习容易过拟合训练数据中的特定 head 几何。FFAvatar 引入 FLAME(标准人头几何参数化模型)作为强 prior —— 模型不直接预测 3D 点云,而是预测 FLAME 形变参数 + 残差。\n\n这两个洞见结合,让模型学到的不是「memorize 单点重建」,而是「**如何从少量观测推断完整几何先验**」。这是 FFAvatar 能用 4 张图达到 20+ 张图方法质量的核心。",
        ],
        method:
          "**三阶段训练课程**\n\n```\n阶段 1: FLAME 单视图重建预训练\n  ↓ (灌输 FLAME 几何 prior)\n阶段 2: Multi-View Query-Former 融合\n  ↓ (学多视角融合能力)\n阶段 3: 端到端微调\n  ↓ (输出 3D 高斯头像 (3DGS) 表示)\n```\n\n**关键组件**:\n\n- **Query-Former**: 8 层 transformer,256 个 3D query tokens,输入支持 1-8 张图\n- **FLAME 参数预测头**: 输出 FLAME 形变参数 (~300 维) + 残差贴片纹理\n- **3D Gaussian 表示**: 最终输出 ~10K 个 3D Gaussian,支持实时渲染\n\n**训练数据**: NeRSemble dataset(110 个 subject,多视角同步采集)。\n\n**推理**: 单 A100,4 张输入图,1.2 秒完成完整重建 + 输出 3DGS。可下游接 standard 3DGS renderer 实时渲染任意视角。",
        experiments: {
          datasets: ["NeRSemble"],
          key_metrics: [
            { name: "PSNR", value: "30.4 dB", vs_baseline: "+2.1" },
            { name: "重建时间", value: "1.2s", vs_baseline: "vs 数小时" },
            { name: "图像数量", value: "4 张", vs_baseline: "vs 20+ 张" },
          ],
          compute: "单 A100",
        },
        industry_impact:
          "**直接打开三个产品场景**:\n\n**VR / AR 头戴**: 现有 VR 平台(如 Meta Horizon、Apple Vision Pro)需要复杂校准流程让用户生成虚拟形象。FFAvatar 让「打开 app → 拍 4 张照 → 立刻有 avatar」成为可能。极大降低 onboarding 门槛。\n\n**直播虚拟主播**: 主播可以快速生成基于真人的虚拟形象(无需建模师参与),迭代周期从天降到分钟。B 站 / Twitch 级别的虚拟主播生态可能从 0 起步。\n\n**ToB 数字人**: 银行 / 客服 / 教育等 ToB 场景的数字人方案,以前需要专业团队建模,FFAvatar 让企业内部 HR 拍几张照就能生成员工数字分身。降本数十倍。\n\n**少图 + 前向流水线的价值**: 重要的不只是速度,而是**整个采集 → 重建链路的极致简化**。这种简化让 avatar 重建从「专业服务」变成「普惠工具」。",
        code_status: {
          narrative: "**项目主页 [ffavatar.github.io](https://ffavatar.github.io/) 已上线 ⚠️ 代码未开源**\n\nBE Phase 4 deep_analysis prompt 需明确标注「**代码尚未公开**」,不要让 LLM 幻觉一个 GH 链接。\n\n**已公开**:\n\n- 项目主页(交互式 demo 展示重建结果)\n- 论文 PDF\n- 部分预渲染视频\n\n**未公开**:\n\n- 训练代码、预训练 checkpoint、推理 demo 代码\n- FLAME 参数预测头实现\n- Multi-View Query-Former 架构细节(论文有大致描述,但缺关键超参)\n\n**社区评论**: 已有 VR researcher 询问消费级 GPU 推理速度(@vr-curious),作者未回复。Reproducibility 仍是开放问题。",
        },
        limitations: [
          "**已知四个局限**:\n\n**1. 极端表情下细节降级**: 大笑 / 哭 / 惊讶等极端表情(FLAME 参数处于训练分布边缘)下,重建质量明显下降。FLAME 标准范围内表情(说话、微笑)质量最好。\n\n**2. 极端光照鲁棒性弱**: 强逆光 / 极弱光 / 多光源混合等场景,Query-Former 难以正确融合视角信息,重建出现明显 artifact。需要数据增强或显式光照分解。\n\n**3. 头发与配饰需后处理**: 长发、眼镜、首饰等高频细节用 ~10K Gaussian 表示精度不够,需要专门的 detail refinement pass(已有相关工作,FFAvatar 未集成)。\n\n**4. 自由视角动画未验证**: 论文只展示了静态重建,没验证「输入静态 4 张 → 输出可动态驱动的 avatar」这条更具产品价值的链路。这是后续工作的开放问题。\n\n**社区担忧**: 缺乏代码 + 评估在单一数据集(NeRSemble),无法验证在 in-the-wild 用户自拍照上的真实效果。",
        ],
        novelty_rating: 2,
      },
      workflow_completed_at: "2026-05-15T08:00:00.000Z",
    },
  },
];

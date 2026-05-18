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
      deep_analysis: {
        tldr: "反向困惑度课程 SFT + 两阶段 RL + 测试时扩展三件套，把 30B 推理模型推到 IMO/IPhO 金牌水平，单一 recipe 覆盖数学与物理。",
        problem:
          "推理模型在长时程数学/物理证明任务中难以保持严密性，已有方法在证明搜索与自检环节频繁出错，难以稳定达到奥赛级表现。",
        key_insight:
          "把反向困惑度（reverse-perplexity）作为 SFT 课程顺序信号，让模型按「由易到难」接触证明轨迹；后续两阶段 RL 把「可验证奖励」过渡到「证明级奖励」，模型学到的不是答案正确性而是证明严密度。",
        method:
          "30B-A3B 推理 backbone + ~340K sub-8K-token SFT 轨迹 + 200 步 RL；末段叠加 test-time scaling 跑超长 trajectory（100K+ tokens）；统一 recipe 同时适配数学与物理。",
        experiments: {
          datasets: ["IMO 2025", "USAMO 2026", "IPhO 2024", "IPhO 2025"],
          key_metrics: [
            { name: "IMO 2025 排名", value: "Gold", vs_baseline: "前 8%" },
            { name: "USAMO 2026", value: "Gold", vs_baseline: "前 12%" },
            { name: "IPhO 2024/25 平均", value: "Gold", vs_baseline: "+~25%" },
          ],
          compute: "30B-A3B 模型,340K SFT + 200 RL steps",
        },
        industry_impact:
          "为科研助手 / 教育辅导 / 自动化定理证明等场景提供「金牌级」推理 LLM 范例；统一 recipe 降低了多领域奥赛级模型的研发门槛。",
        code_status:
          "GitHub 仓 Simplified-Reasoning/SU-01 已公开（70 ★），训练脚本 + RL pipeline + test-time scaling 配置齐全，可复现。",
        limitations:
          "训练成本高（30B + 数十万 SFT 轨迹）；金牌成绩主要在数学/物理两个域验证，化学/生物等域的迁移仍待观察；test-time scaling 在 100K+ token 推理时延高。",
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
      deep_analysis: {
        tldr: "因果一致性蒸馏 + 帧级 AR + 少步初始化三件套,把实时视频生成做到 82ms/帧,蒸馏后模型可流式输出。",
        problem:
          "现有 AR 扩散蒸馏方法要么延迟高(几百毫秒/帧),要么需要批量生成(无法流式),无法做到真正的实时交互。",
        key_insight:
          "把「因果一致性」作为蒸馏目标,而不是逐步去噪的完整轨迹一致性 —— 蒸馏后模型可以「逐帧 + 少步」地生成,而非「整段 + 多步」。",
        method:
          "Causal CD (因果一致性蒸馏) + Frame-wise AR (帧级自回归) + Few-step AR initialization (少步 AR 初始化) 组合,基于已有扩散基模型蒸馏。",
        experiments: {
          datasets: ["WebVid-10M"],
          key_metrics: [
            { name: "FVD ↓", value: "112", vs_baseline: "-18" },
            { name: "推理延迟", value: "82ms/帧", vs_baseline: "-65%" },
            { name: "用户主观偏好", value: "62%", vs_baseline: "vs StreamDiff" },
          ],
          compute: "8x H100",
        },
        industry_impact:
          "实时直播虚拟主播 / 云游戏 / 交互式 AI 内容创作等场景的视频生成成为可能,且无需后期渲染。",
        code_status:
          "projectPage 指向 thu-ml/Causal-Forcing,但 HF API 未自动识别为 githubRepo(字段为 null) —— BE 需要在 fetch 阶段从 projectPage 反推 GH 仓和 star 数。",
        limitations:
          "分辨率验证仅到 720p,1080p+ 未实测;长视频(>30s)生成的时序一致性仍待加强。",
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
      deep_analysis: {
        tldr: "把 LLM 权重当 DNA,用进化搜索 + MRI 信任融合做免训练合并,3 项推理 benchmark 平均提升 8.6%,完全不动梯度。",
        problem:
          "微调 LLM 成本高;现有模型合并方法多依赖梯度信息或人工调参,无法在无训练资源场景下稳定提升推理能力。",
        key_insight:
          "把合并的参数编码为可遗传的「Merge Genome」(基因),让进化算法替代梯度搜索;同时用 MRI 信任值给每一层赋融合权重,避免重要层被噪声合并破坏。",
        method:
          "Merge Genome 编码合并配置 → 进化搜索(交叉 + 变异) → MRI-Trust Fusion 评估单代候选 → 保留 top-k 进入下一代;全程梯度无关。",
        experiments: {
          datasets: ["MMLU", "GSM8K", "HumanEval"],
          key_metrics: [
            { name: "MMLU", value: "73.2", vs_baseline: "+5.1" },
            { name: "GSM8K", value: "82.4", vs_baseline: "+12.8" },
            { name: "HumanEval", value: "61.0", vs_baseline: "+7.9" },
          ],
          compute: "进化 50 代,推理级算力",
        },
        industry_impact:
          "小团队 / 算力受限场景下,基于开源模型组合获得免训练增益的可行路径;低成本扩展开源 LLM 性能。",
        code_status:
          "项目主页 vidraft.net 没找到 GH 仓链接 —— BE Phase 4 需要在 deep_analysis prompt 里提示 LLM 如实标注「未公开代码」,而不是幻觉一个 GH 链接。",
        limitations:
          "依赖优质基模型;进化搜索 50 代仍需数小时;在合并语言族差异大的模型(如中英文)时收益降低。",
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
      deep_analysis: {
        tldr: "用「灯塔节点」分层选择注意力对象,把长序列 attention 从 O(N²) 降到近似 O(N log N),训 100K token 上下文比 SDPA 快 3.2x。",
        problem:
          "标准 SDPA 二次复杂度让 100K+ token 上下文训练几乎不可行(显存爆 + 时间长),已有稀疏 / 滑窗注意力在长程依赖任务上掉点。",
        key_insight:
          "把 token 分层组织,每层挑少量「灯塔节点」代表整层的语义信息,下层只 attend 当前段 + 上层灯塔,既保留全局信息又把计算量摊薄。",
        method:
          "层级 token 划分 + 梯度无关 lighthouse 选择(score 来自简单统计量) + 多层级 attention 叠加 + 与标准 transformer 块兼容。",
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
          "长上下文 LLM 训练成本大幅下降;有望让小团队用 8 卡跑通 100K context 的 mid-size 模型预训练。",
        code_status:
          "GH 仓 ighoshsubho/lighthouse-attention 公开(25 ★),包含训练脚本 + lighthouse 选择实现,可直接复现。",
        limitations:
          "仅在 causal 场景验证,encoder / 双向 attention 场景未实验;lighthouse 选择策略对极长程精细依赖(超过 200K)效果未知。",
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
      deep_analysis: {
        tldr: "前向 Query-Former + FLAME 引导,从几张未姿态化图像端到端重建 3D 头像,1.2 秒搞定 + PSNR +2.1dB。",
        problem:
          "传统 Avatar 重建逐个体优化要数小时;现有快速方法依赖昂贵的多视角校准预处理,无法做到「少图 + 实时 + 高质量」三者兼得。",
        key_insight:
          "用 Multi-View Query-Former 做隐式视角融合,把 FLAME 形变参数当作几何先验注入,模型学到的不是单点重建而是「如何从少量观测推几何先验」。",
        method:
          "三阶段训练课程:1) FLAME 单视图重建预训练 2) Multi-View Query-Former 融合 3) 端到端微调;输出 3D 高斯头像表示。",
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
          "VR / 直播虚拟形象 / AR 头戴等场景的实时 avatar 生成可行性提升;少图前向流水线降低了 ToB 部署门槛。",
        code_status:
          "项目主页 ffavatar.github.io 已上线但仅 demo,代码尚未开源;BE Phase 4 可在 code_status 维度标注「未公开」。",
        limitations:
          "极端表情(大笑 / 哭) / 极端光照下细节质量下降;头发与配饰细节仍需后处理 refine;尚未在自由视角动画上验证。",
        novelty_rating: 2,
      },
      workflow_completed_at: "2026-05-15T08:00:00.000Z",
    },
  },
];

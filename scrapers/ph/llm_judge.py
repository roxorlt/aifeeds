"""DeepSeek V4 Flash judge for Product Hunt launches.

Per-product single call: classify (is_ai + category) + summarize (中文 100-200字).
Failure → mark is_ai=NULL，下次 cron 取 NULL 行重判。

输入字段（来自 parser.parse_product_page + 后续 DOM 抓取）：
  name / tagline / description / maker_post (可选) / top_comments_sample (可选)

输出严格 JSON：
  { is_ai: 0/1, ai_category: <slug>|null, ai_summary: <中文>|"" }
"""
from __future__ import annotations

import json
import logging
from typing import Any

from openai import OpenAI

from .._lib import config

log = logging.getLogger(__name__)

# AI category slugs — 跟 design doc § 4.1 一致
AI_CATEGORIES = (
    "ai_code_editor",
    "ai_chatbot",
    "ai_agent",
    "ai_image_gen",
    "ai_video_gen",
    "ai_audio",
    "ai_writing",
    "ai_search",
    "ai_dev_tool",
    "ai_workflow",
    "ai_voice_agent",
    "ai_data_analysis",
    "ai_design_tool",
    "ai_other",
)

SYSTEM_PROMPT = """你是 AI 信息聚合看板的内容审核员。任务：判断 Product Hunt 上线产品是否"AI 相关"，并给中文用户写一段简短解读。

【判别标准】is_ai=1：
- 产品核心功能依赖 AI / LLM / ML / CV / NLP 模型
- AI 是产品主打卖点（首页 / tagline 突出）
- AI Agent / 多 agent 编排 / RAG / vector DB / inference engine 类
- 给 AI 工程的工具链（prompt 工具 / eval / observability / model dev tools）

is_ai=0：
- 普通 SaaS / utility，仅集成 AI 作为附加功能（如有 AI 自动补全的非 AI 编辑器）
- 设计 / 营销 / 通讯 / 项目管理类（即使可能用 AI 推荐，主要价值仍是非 AI）
- 区块链 / 加密货币
- 单纯的内容平台 / 社区 / 社交

边界模糊时按"产品主打价值是否依赖 AI/ML"判：是→1，不是→0。

【分类】ai_category（is_ai=1 时必填，选一个最主要的）：
- ai_code_editor:    AI 代码编辑器（Cursor 类）/ IDE 插件 / 代码补全
- ai_chatbot:        通用聊天 / 对话界面 / 智能助手
- ai_agent:          自主 agent / 多 agent / RPA 类自动化
- ai_image_gen:      文生图 / 图生图 / image enhancer / icon gen
- ai_video_gen:      文生视频 / 视频编辑 / motion / animation
- ai_audio:          语音合成 / TTS / 音频编辑 / 配音
- ai_writing:        文案 / 写作助手 / 翻译 / 校对
- ai_search:         AI 搜索 / RAG 应用 / 知识库
- ai_dev_tool:       开发者工具（SDK / API / observability / eval / prompt 工具）
- ai_workflow:       AI 工作流编排 / no-code AI builder / orchestrator
- ai_voice_agent:    语音 agent / 通话机器人 / IVR
- ai_data_analysis:  数据分析 / BI / 报表 AI
- ai_design_tool:    AI 设计 / UI 生成 / Figma 类插件
- ai_other:          AI 相关但不属于上述

【解读】ai_summary（is_ai=1 时必填，100-200 中文字）：
- 第一句：直接说产品做什么（不要"X 是一个..."套路）。
  反例：「Cursor 是一个 AI 代码编辑器...」（错）
  正例：「主打 AI pair programming 的代码编辑器，内置 Claude / GPT 多模型快速切换...」（对）
- 第二句：独特卖点或与同类差异
- 第三句：适用人群（开发者 / 设计师 / 内容创作者 / 商业用户 / 学术研究 / 其他）
- 中国 AI 从业者口吻，专有名词保留英文
- 禁用营销腔（"必看" / "重磅" / "最强" / "颠覆"）
- 如果 maker post 有特殊背景（融资 / 开源 / 学校 / 团队来源）可一笔带过

【输出】严格 JSON：
{"is_ai": 0或1, "ai_category": "<slug>"|null, "ai_summary": "..."}
is_ai=0 时 ai_category=null, ai_summary=""。"""


def _client() -> OpenAI:
    if not config.DEEPSEEK_API_KEY:
        raise RuntimeError("DEEPSEEK_API_KEY missing — cannot run LLM judge")
    return OpenAI(api_key=config.DEEPSEEK_API_KEY, base_url=config.DEEPSEEK_BASE_URL)


def build_user_prompt(product: dict[str, Any]) -> str:
    """Build prompt from a parsed product dict (parser.parse_product_page output)."""
    name = product.get("name") or "?"
    tagline = product.get("tagline") or ""
    pricing = (product.get("metrics") or {}).get("pricing_type") or ""
    maker_post = product.get("maker_post_text") or ""
    if len(maker_post) > 1500:
        maker_post = maker_post[:1500] + "\n[...截断]"
    top_comments = product.get("top_comments") or []
    sample_comments = []
    for c in top_comments[:3]:
        text = (c.get("text") or "")[:200]
        if text:
            sample_comments.append(f"- {text}")
    comment_block = "\n".join(sample_comments) if sample_comments else "(无)"

    parts = [
        f"产品名：{name}",
        f"Tagline：{tagline}",
        f"Pricing：{pricing}" if pricing else "",
        "",
        "Maker Post：",
        maker_post or "(无)",
        "",
        "Top 评论样本（前 3 条）：",
        comment_block,
    ]
    return "\n".join(p for p in parts if p)


def judge_product(product: dict[str, Any]) -> dict[str, Any]:
    """单产品 LLM judge 调用。返回 {is_ai, ai_category, ai_summary}。

    失败 → 抛 RuntimeError 让 caller 处理（mark is_ai=NULL）。
    """
    client = _client()
    user_prompt = build_user_prompt(product)
    log.debug("LLM judge prompt for %s:\n%s", product.get("_slug"), user_prompt[:500])

    resp = client.chat.completions.create(
        model=config.DEEPSEEK_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=600,
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        out = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"LLM returned invalid JSON: {e}\n{raw[:300]}")

    # 校验
    is_ai = int(out.get("is_ai", 0))
    cat = out.get("ai_category")
    summary = (out.get("ai_summary") or "").strip()
    if is_ai == 1:
        if cat not in AI_CATEGORIES:
            log.warning("LLM returned invalid category %r, falling back to ai_other", cat)
            cat = "ai_other"
        if not summary:
            log.warning("LLM marked is_ai=1 but summary empty for %s", product.get("_slug"))
    else:
        cat = None
        summary = ""
    return {"is_ai": is_ai, "ai_category": cat, "ai_summary": summary}

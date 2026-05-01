"""DeepSeek V4 Flash judge for GitHub repos.

Per-repo single call: classify (is_ai + category) + summarize.
Failure → mark is_ai=NULL, PushDeer notify, next cron retry picks NULL rows.

Prompt v2 verified on TradingAgents (see /tmp/test_gh_llm.py + design doc §4):
  - First sentence not "ProjectName 是一个..." (forced via positive/negative examples)
  - Disclaimer-bearing READMEs preserve a closing sentence
  - JSON output via response_format
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from openai import OpenAI

from .._lib import config, pushdeer

log = logging.getLogger(__name__)

_MAX_README_CHARS = 800_000
_MAX_RETRIES = 1  # LLM API failure → retry once → mark NULL

SYSTEM_PROMPT = """你是 AI 信息聚合看板的内容审核员。任务：判断 GitHub 项目是否"AI 相关"，并给中文用户写一段简短解读。

【判别标准】is_ai=1：
- LLM/agent 框架与应用（langchain, autogpt, crewai）
- ML/DL 模型权重、训练/推理实现（llama.cpp, sglang）
- AI 开发工具（cursor, aider, continue 类 IDE 插件 / CLI）
- AI 基础设施（向量库、RAG、推理引擎、eval 框架、模型部署）
- 终端用户 AI 应用（comfyui, openwebui, automatic1111）
- AI 教程 / awesome list / prompt 集合
- AI 论文实现 / 复现仓库

is_ai=0：
- 通用 web 框架、数据库、操作系统
- DevOps / 监控 / 容器编排（除非专为 ML 训练/推理）
- 区块链 / 加密货币
- 纯算法/数据结构库（除非专为 ML）
- 通用编辑器、设计工具
边界模糊时按"项目主要价值是否依赖 AI/ML"判：是→1，不是→0。

【分类】ai_category（is_ai=1 时必填，选一个最主要的）：
- agent: LLM agent 框架 / 构建好的 agent 产品
- model: 模型权重、训练/推理代码实现
- tool: 给开发者的 SDK / 库 / CLI（langchain, llamaindex, aider）
- infra: 部署/服务/基础设施（vllm, triton, ray serve, 向量库）
- app: 给终端用户的开箱即用产品（有完整 UI）
- tutorial: 教程、awesome list、课程、prompt 集合
- other: AI 相关但不属于上述

【解读】ai_summary（is_ai=1 时必填，80-150 中文字）：
- 第一句：项目做什么（不要抄 description 原话）。第一句必须以动词或名词短语直接开头，不要以"项目名 + 是一个 X"或"项目名 + 是 X"开头。
  反例：「TradingAgents 是一个多智能体金融交易框架...」（错）
  正例：「多智能体金融交易框架，把分析师/研究员/交易员拆成专门 agent 协作...」（对）
  正例：「通过 LangGraph 编排多个 LLM Agent 模拟交易团队协作的金融决策框架...」（对）
- 第二句：为什么值得看（亮点 / 跟同类的差异 / 当前热度的原因）
- 如果 README 有 disclaimer / license 限制 / "research-only" 等声明，必须在 summary 末尾保留一句（如"研究向，非投资/医疗建议"）
- 中国 AI 从业者口吻，专有名词保留英文
- 禁用营销腔（"必看"/"重磅"/"最强"）

【输出】严格 JSON：
{"is_ai": 0或1, "ai_category": "agent"|"model"|"tool"|"infra"|"app"|"tutorial"|"other"|null, "ai_summary": "..."}
is_ai=0 时 ai_category=null, ai_summary=""。"""


def _client() -> OpenAI:
    if not config.DEEPSEEK_API_KEY:
        raise RuntimeError("DEEPSEEK_API_KEY missing — cannot run LLM judge")
    return OpenAI(api_key=config.DEEPSEEK_API_KEY, base_url=config.DEEPSEEK_BASE_URL)


def build_user_prompt(repo: dict[str, Any]) -> str:
    readme = repo.get("readme_excerpt") or ""
    if len(readme) > _MAX_README_CHARS:
        readme = readme[:_MAX_README_CHARS] + "\n\n[... README 已截断 ...]"
    return (
        f"项目: {repo['owner_repo']}\n"
        f"GitHub Description: {repo.get('description') or '无'}\n"
        f"主语言: {repo.get('language') or '未知'}\n"
        f"总 stars: {repo.get('total_stars', 'unknown')}（今日新增 {repo.get('today_stars', 'unknown')}）\n\n"
        f"README（截断到前 {_MAX_README_CHARS} 字符）:\n---\n{readme}\n---"
    )


def _validate_response(parsed: dict[str, Any]) -> None:
    """Raise ValueError if response shape is wrong."""
    is_ai = parsed.get("is_ai")
    if is_ai not in (0, 1):
        raise ValueError(f"is_ai must be 0 or 1, got {is_ai!r}")
    if is_ai == 1:
        cat = parsed.get("ai_category")
        if cat not in ("agent", "model", "tool", "infra", "app", "tutorial", "other"):
            raise ValueError(f"ai_category invalid for is_ai=1: {cat!r}")
        summary = parsed.get("ai_summary") or ""
        if not summary or len(summary) < 20:
            raise ValueError(f"ai_summary too short for is_ai=1: {summary!r}")


def judge(repo: dict[str, Any]) -> dict[str, Any]:
    """Call LLM, return {is_ai, ai_category, ai_summary, llm_raw_response, llm_model}.

    On total failure (after retries), returns {is_ai: None, ...} so caller can
    persist NULL and pick up on next cron.
    """
    client = _client()
    user_prompt = build_user_prompt(repo)

    last_err: Exception | None = None
    for attempt in range(_MAX_RETRIES + 1):
        try:
            resp = client.chat.completions.create(
                model=config.DEEPSEEK_MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0,
                max_tokens=600,
                response_format={"type": "json_object"},
            )
            raw = resp.choices[0].message.content.strip()
            parsed = json.loads(raw)
            _validate_response(parsed)
            return {
                "is_ai": parsed["is_ai"],
                "ai_category": parsed.get("ai_category") if parsed["is_ai"] == 1 else None,
                "ai_summary": parsed.get("ai_summary") if parsed["is_ai"] == 1 else "",
                "llm_raw_response": raw,
                "llm_model": config.DEEPSEEK_MODEL,
                "llm_called_at": int(time.time()),
            }
        except (json.JSONDecodeError, ValueError, KeyError) as exc:
            last_err = exc
            log.warning("LLM judge invalid response for %s (attempt %d): %s",
                        repo["owner_repo"], attempt + 1, exc)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log.warning("LLM judge API error for %s (attempt %d): %s",
                        repo["owner_repo"], attempt + 1, exc)

    # Total failure: notify + return NULL placeholder
    err_msg = str(last_err) if last_err else "unknown"
    pushdeer.push(
        title=f"ai-feeds | GitHub LLM 失败",
        body=(
            f"仓库: {repo['owner_repo']}\n"
            f"错误: {err_msg}（重试 {_MAX_RETRIES} 次后放弃）\n"
            f"trending_date: {repo.get('trending_date_str', 'unknown')}\n"
            f"raw response（如有）已存 DB llm_raw_response"
        ),
    )
    return {
        "is_ai": None,
        "ai_category": None,
        "ai_summary": "",
        "llm_raw_response": None,
        "llm_model": config.DEEPSEEK_MODEL,
        "llm_called_at": int(time.time()),
    }

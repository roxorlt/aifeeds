"""DeepSeek 批量翻译 PH 产品文本。

按 design doc § 4.2 + Q7 决策：
  翻：tagline / maker post / top_comments[].text / top_reviews[].body
  不翻：categories 名称（保留英文）/ reviews 的 positive/negative notes（短词翻译失真）

策略：单产品所有 text segments 拼一个 prompt，让 LLM 用编号分隔输出，
减少 API call 次数（17 segments × 30 products / day = 510 → 30 calls / day）。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from openai import OpenAI

from .._lib import config

log = logging.getLogger(__name__)


SYSTEM_PROMPT = """你是把 Product Hunt 英文文本翻译为简体中文的翻译员。

【风格】
- tagline / maker post: 正式 product copy 调性
- 用户评论 / review: 自然口语化，保留语气词、emoji
- 中国 AI 从业者熟悉的术语用法（保留 LLM / RAG / agent / Cursor / Claude /
  GPT / TypeScript / LSP / Slack 等专有名词原文）
- 保留 @username（不翻）

【格式】
- 输入是 JSON {"items":[{"id":"<seg_id>","text":"<原文>"}, ...]}
- 输出严格 JSON {"translations":[{"id":"<seg_id>","text":"<译文>"}, ...]}
- id 不能改，必须跟输入一一对应
- 译文保留原 markdown / 链接 / @ / # 等
- 空字符串 / 已是中文的不译，原样返回"""


def _client() -> OpenAI:
    if not config.DEEPSEEK_API_KEY:
        raise RuntimeError("DEEPSEEK_API_KEY missing — cannot translate")
    return OpenAI(api_key=config.DEEPSEEK_API_KEY, base_url=config.DEEPSEEK_BASE_URL)


_NON_LATIN = re.compile(r"[一-鿿぀-ゟ゠-ヿ가-힯]")


def _is_already_translated(text: str) -> bool:
    """超过 5% 的字符是 CJK 就当作已翻 / 原本就是中文，跳过。"""
    if not text:
        return True
    cjk = len(_NON_LATIN.findall(text))
    return cjk / max(1, len(text)) > 0.05


def _batch_translate(items: list[dict[str, str]]) -> dict[str, str]:
    """items=[{id:..., text:...}, ...] → {id: translated_text}"""
    if not items:
        return {}

    # 过滤已是中文的，原样返回
    to_translate = [it for it in items if not _is_already_translated(it["text"])]
    out = {it["id"]: it["text"] for it in items if _is_already_translated(it["text"])}
    if not to_translate:
        return out

    client = _client()
    resp = client.chat.completions.create(
        model=config.DEEPSEEK_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({"items": to_translate}, ensure_ascii=False)},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
        max_tokens=4000,
    )
    raw = resp.choices[0].message.content or "{}"
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Translation returned invalid JSON: {e}\n{raw[:300]}")

    for tr in result.get("translations", []):
        sid = tr.get("id")
        text = tr.get("text", "")
        if sid:
            out[sid] = text
    # 任何漏掉的：fallback 用原文
    for it in to_translate:
        out.setdefault(it["id"], it["text"])
    return out


def translate_product(p: dict[str, Any]) -> None:
    """In-place 给产品 dict 加翻译字段。

    新加字段：
      p["tagline_translated"]
      p["maker_post_translated"]
      p["top_comments"][i]["translated"]
      p["top_reviews"][i]["body_translated"]
    """
    items: list[dict[str, str]] = []

    if p.get("tagline"):
        items.append({"id": "tagline", "text": p["tagline"]})

    maker_post_text = p.get("maker_post_text", "")
    if maker_post_text:
        items.append({"id": "maker_post", "text": maker_post_text})

    for i, c in enumerate(p.get("top_comments", [])):
        if c.get("text"):
            items.append({"id": f"comment_{i}", "text": c["text"]})

    for i, r in enumerate(p.get("top_reviews", [])):
        if r.get("body"):
            items.append({"id": f"review_{i}", "text": r["body"]})

    if not items:
        return
    log.debug("translating %d segments for %s", len(items), p.get("_slug"))

    translations = _batch_translate(items)

    p["tagline_translated"] = translations.get("tagline", "")
    p["maker_post_translated"] = translations.get("maker_post", "")

    for i, c in enumerate(p.get("top_comments", [])):
        c["translated"] = translations.get(f"comment_{i}", "")

    for i, r in enumerate(p.get("top_reviews", [])):
        r["body_translated"] = translations.get(f"review_{i}", "")

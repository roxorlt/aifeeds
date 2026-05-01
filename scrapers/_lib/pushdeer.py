"""PushDeer notifier — concurrent push to multiple keys.

Adapted from /Users/roxor/brain/30-projects/xueqiuFollow/src/notifier.py:230-302.
Trimmed: no group/admin/subscriber distinction, no enhanced body, no concurrent
order semantics — just "push title+body to every configured key".
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from . import config

log = logging.getLogger(__name__)


def push(title: str, body: str, keys: list[str] | None = None) -> dict[str, str | None]:
    """Push to every key concurrently. Returns {label: error_or_none}.

    Caller's responsibility to log/fail. We just push and report.
    """
    keys = keys if keys is not None else config.PUSHDEER_KEYS
    if not keys:
        log.warning("pushdeer.push called but no keys configured")
        return {}

    def _push_one(key: str) -> tuple[str, str | None]:
        label = key[:8] + "…"
        try:
            resp = requests.post(
                config.PUSHDEER_ENDPOINT,
                data={"pushkey": key, "text": title, "desp": body, "type": "markdown"},
                timeout=10,
            )
            data = resp.json()
            if data.get("code") != 0:
                err = data.get("error", str(data))
                return label, err
        except Exception as exc:
            return label, str(exc)
        return label, None

    results: dict[str, str | None] = {}
    with ThreadPoolExecutor(max_workers=max(1, len(keys))) as pool:
        futures = {pool.submit(_push_one, k): k for k in keys}
        for fut in as_completed(futures):
            label, err = fut.result()
            results[label] = err
            if err:
                log.error("pushdeer fail (%s): %s", label, err)

    return results

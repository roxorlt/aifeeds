# xList Scraper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a global skill that scrapes X (Twitter) Lists, filters AI-related tweets, translates English to Chinese, and stores results in SQLite.

**Architecture:** Global skill (`~/.claude/skills/xlist-scraper/`) triggers Python scripts that use browser-use Python API for scraping and DeepSeek Chat API for translation/filtering. Data persists in SQLite at `~/brain/30-projects/aifeeds/data/xlist.db`.

**Tech Stack:** Python 3.13 (browser-use venv), browser-use Python API, DeepSeek Chat (OpenAI-compatible), SQLite3, Chrome cookie decryption (pbkdf2 + AES-CBC)

---

### Task 1: Database & Config

**Files:**
- Create: `~/.claude/skills/xlist-scraper/scripts/config.py`
- Create: `~/.claude/skills/xlist-scraper/scripts/db.py`

**Step 1: Write config.py**

```python
"""Configuration for xlist-scraper."""
from pathlib import Path

# Paths
PROJECT_DIR = Path.home() / "brain" / "30-projects" / "xlist-scraper"
DB_PATH = PROJECT_DIR / "data" / "xlist.db"
PAGES_DIR = PROJECT_DIR / "data" / "pages"  # temp page storage for crash recovery
EXPORTS_DIR = PROJECT_DIR / "exports"

# Browser
CHROME_PROFILE = "Profile 1"  # small profile for browser-use
COOKIE_SOURCE_PROFILE = "Default"  # where x.com cookies live
CHROME_DATA_DIR = Path.home() / "Library" / "Application Support" / "Google" / "Chrome"

# DeepSeek
DEEPSEEK_API_KEY = "sk-***REDACTED-2026-05-10***"
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL = "deepseek-chat"

# Scraping
SCROLL_PAUSE_SEC = 2.0  # wait between scrolls
MAX_SCROLL_RETRIES = 3  # retries when no new tweets appear
TWEETS_PER_PAGE = 20  # approx tweets per scroll batch
BATCH_TRANSLATE_SIZE = 5  # tweets per translation batch

# AI keywords for fast filter
AI_KEYWORDS = [
    "AI", "AGI", "LLM", "GPT", "Claude", "Gemini", "Llama", "Mistral",
    "OpenAI", "Anthropic", "DeepSeek", "Google AI", "Meta AI",
    "machine learning", "deep learning", "neural", "transformer",
    "diffusion", "fine-tun", "RLHF", "token", "embedding",
    "inference", "training", "benchmark", "reasoning", "agent",
    "multimodal", "vision model", "language model", "foundation model",
    "人工智能", "大模型", "大语言模型", "机器学习", "深度学习",
    "智能体", "生成式", "提示词", "微调",
]
```

**Step 2: Write db.py**

```python
"""SQLite database management."""
import sqlite3
import json
from pathlib import Path
from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS lists (
    list_id       TEXT PRIMARY KEY,
    name          TEXT,
    url           TEXT,
    last_cursor   TEXT,
    last_run_at   TEXT,
    total_fetched INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tweets (
    tweet_id      TEXT PRIMARY KEY,
    list_id       TEXT NOT NULL,
    author_handle TEXT,
    author_name   TEXT,
    content       TEXT,
    translated    TEXT,
    language      TEXT,
    is_ai_related INTEGER,
    attachments   TEXT,
    tweet_url     TEXT,
    fetched_at    TEXT,
    processed_at  TEXT,
    published_at  TEXT,
    status        TEXT DEFAULT 'raw',
    FOREIGN KEY (list_id) REFERENCES lists(list_id)
);

CREATE INDEX IF NOT EXISTS idx_tweets_list_status ON tweets(list_id, status);
CREATE INDEX IF NOT EXISTS idx_tweets_list_time ON tweets(list_id, published_at);
"""


def get_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def upsert_list(conn: sqlite3.Connection, list_id: str, name: str = "", url: str = ""):
    conn.execute(
        "INSERT INTO lists (list_id, name, url) VALUES (?, ?, ?) "
        "ON CONFLICT(list_id) DO UPDATE SET name=COALESCE(NULLIF(?,''}, name), url=COALESCE(NULLIF(?,''), url)",
        (list_id, name, url, name, url),
    )
    conn.commit()


def get_cursor(conn: sqlite3.Connection, list_id: str) -> str | None:
    row = conn.execute("SELECT last_cursor FROM lists WHERE list_id = ?", (list_id,)).fetchone()
    return row["last_cursor"] if row else None


def update_cursor(conn: sqlite3.Connection, list_id: str, cursor: str):
    conn.execute(
        "UPDATE lists SET last_cursor = ?, last_run_at = datetime('now') WHERE list_id = ?",
        (cursor, list_id),
    )
    conn.commit()


def insert_tweets(conn: sqlite3.Connection, tweets: list[dict]):
    for t in tweets:
        conn.execute(
            """INSERT OR IGNORE INTO tweets
            (tweet_id, list_id, author_handle, author_name, content, language,
             attachments, tweet_url, fetched_at, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)""",
            (
                t["tweet_id"], t["list_id"], t["author_handle"], t["author_name"],
                t["content"], t.get("language"), json.dumps(t.get("attachments", []), ensure_ascii=False),
                t["tweet_url"], t.get("published_at"),
            ),
        )
    conn.commit()


def get_raw_tweets(conn: sqlite3.Connection, list_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM tweets WHERE list_id = ? AND status = 'raw' ORDER BY tweet_id",
        (list_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def mark_processed(conn: sqlite3.Connection, tweet_id: str, is_ai: bool, translated: str | None):
    conn.execute(
        """UPDATE tweets SET is_ai_related = ?, translated = ?,
        processed_at = datetime('now'), status = 'processed'
        WHERE tweet_id = ?""",
        (1 if is_ai else 0, translated, tweet_id),
    )
    conn.commit()


def mark_emitted(conn: sqlite3.Connection, tweet_ids: list[str]):
    conn.executemany(
        "UPDATE tweets SET status = 'emitted' WHERE tweet_id = ?",
        [(tid,) for tid in tweet_ids],
    )
    conn.commit()


def get_stats(conn: sqlite3.Connection, list_id: str) -> dict:
    row = conn.execute(
        """SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status='raw' THEN 1 ELSE 0 END) as raw_count,
            SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) as processed_count,
            SUM(CASE WHEN status='emitted' THEN 1 ELSE 0 END) as emitted_count,
            SUM(CASE WHEN is_ai_related=1 THEN 1 ELSE 0 END) as ai_related,
            SUM(CASE WHEN is_ai_related=0 THEN 1 ELSE 0 END) as not_ai_related
        FROM tweets WHERE list_id = ?""",
        (list_id,),
    ).fetchone()
    return dict(row)
```

**Step 3: Verify**

Run: `cd ~/.claude/skills/xlist-scraper/scripts && ~/.browser-use-env/bin/python3 -c "from db import get_db; db=get_db(); print('DB OK:', db.execute('SELECT name FROM sqlite_master').fetchall())"`

Expected: DB created, tables listed.

---

### Task 2: Cookie Manager

**Files:**
- Create: `~/.claude/skills/xlist-scraper/scripts/cookie_manager.py`

**Step 1: Write cookie_manager.py**

```python
"""Extract cookies from Chrome Default profile and inject into browser-use session."""
import subprocess
import sqlite3
import shutil
import tempfile
from hashlib import pbkdf2_hmac
from pathlib import Path
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from config import CHROME_DATA_DIR, COOKIE_SOURCE_PROFILE


def _get_chrome_key() -> bytes:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "Chrome Safe Storage", "-w"],
        capture_output=True, text=True, check=True,
    )
    password = result.stdout.strip()
    return pbkdf2_hmac("sha1", password.encode("utf-8"), b"saltysalt", 1003, dklen=16)


def _decrypt_v10(encrypted_value: bytes, key: bytes) -> str:
    data = encrypted_value[3:]  # skip 'v10' prefix
    iv = b" " * 16
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(data) + decryptor.finalize()
    # PKCS7 padding removal
    padding_len = decrypted[-1]
    if isinstance(padding_len, int) and 1 <= padding_len <= 16:
        decrypted = decrypted[:-padding_len]
    # Strip 32-byte garbage prefix (Chrome macOS quirk)
    if len(decrypted) > 32:
        prefix = decrypted[:32]
        rest = decrypted[32:]
        if any(b < 32 and b not in (9, 10, 13) for b in prefix):
            decrypted = rest
    return decrypted.decode("utf-8", errors="replace")


def extract_x_cookies() -> list[dict]:
    """Extract and decrypt x.com/twitter.com cookies from Chrome Default profile."""
    key = _get_chrome_key()
    src = CHROME_DATA_DIR / COOKIE_SOURCE_PROFILE / "Cookies"
    tmp = tempfile.mktemp(suffix=".db")
    shutil.copy2(src, tmp)

    CHROME_EPOCH_DELTA = 11644473600

    conn = sqlite3.connect(tmp)
    rows = conn.execute(
        """SELECT host_key, name, encrypted_value, path, is_secure, is_httponly,
                  expires_utc, samesite
           FROM cookies
           WHERE host_key LIKE '%x.com' OR host_key LIKE '%twitter.com'"""
    ).fetchall()
    conn.close()
    Path(tmp).unlink()

    cookies = []
    ss_map = {0: "None", 1: "Lax", 2: "Strict", -1: "None"}
    for host, name, enc_val, path, secure, httponly, expires, samesite in rows:
        if not enc_val or enc_val[:3] != b"v10":
            continue
        value = _decrypt_v10(enc_val, key)
        if not value:
            continue
        entry = {"name": name, "value": value, "domain": host, "path": path}
        if secure:
            entry["secure"] = True
        if httponly:
            entry["httpOnly"] = True
        if expires and expires > 0:
            entry["expires"] = (expires / 1000000) - CHROME_EPOCH_DELTA
        entry["sameSite"] = ss_map.get(samesite, "Lax")
        cookies.append(entry)
    return cookies


async def inject_cookies(session, cookies: list[dict]):
    """Inject cookies into a browser-use session via CDP."""
    await session._cdp_set_cookies(cookies)
```

**Step 2: Verify**

Run: `cd ~/.claude/skills/xlist-scraper/scripts && ~/.browser-use-env/bin/python3 -c "from cookie_manager import extract_x_cookies; cs=extract_x_cookies(); auth=[c for c in cs if c['name'] in ('auth_token','ct0')]; print(f'{len(cs)} cookies, auth: {[c[\"name\"] for c in auth]}')"`

Expected: `42 cookies, auth: ['auth_token', 'ct0']`

---

### Task 3: List Scraper

**Files:**
- Create: `~/.claude/skills/xlist-scraper/scripts/list_scraper.py`

**Step 1: Write list_scraper.py**

```python
"""Scrape tweets from an X List using browser-use Python API."""
import asyncio
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from browser_use import BrowserSession
from config import (
    CHROME_PROFILE, SCROLL_PAUSE_SEC, MAX_SCROLL_RETRIES, PAGES_DIR,
)
from cookie_manager import extract_x_cookies, inject_cookies

# Beijing timezone
BJT = timezone(timedelta(hours=8))

# JS to extract tweets from DOM
EXTRACT_JS = """(...args) => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const tweets = [];
    for (const article of articles) {
        try {
            // Author
            const userLink = article.querySelector('a[role="link"][href*="/"]');
            const handle = userLink ? userLink.getAttribute('href').replace('/', '') : '';
            const nameEl = article.querySelector('[data-testid="User-Name"]');
            const authorName = nameEl ? nameEl.querySelector('span')?.innerText || '' : '';

            // Content
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const content = textEl ? textEl.innerText : '';

            // Tweet URL (contains status ID)
            const timeLink = article.querySelector('a[href*="/status/"] time')?.parentElement;
            const tweetUrl = timeLink ? 'https://x.com' + timeLink.getAttribute('href') : '';
            const tweetId = tweetUrl.match(/status\\/(\\d+)/)?.[1] || '';

            // Published time
            const timeEl = article.querySelector('time');
            const publishedAt = timeEl ? timeEl.getAttribute('datetime') : '';

            // Attachments (images, videos)
            const attachments = [];
            article.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
                attachments.push({type: 'image', url: img.src});
            });
            article.querySelectorAll('video').forEach(vid => {
                attachments.push({type: 'video', url: vid.src || vid.poster || ''});
            });

            // Language detection (basic)
            const hasChinese = /[\\u4e00-\\u9fff]/.test(content);
            const language = hasChinese ? 'zh' : 'en';

            if (tweetId && content) {
                tweets.push({
                    tweet_id: tweetId,
                    author_handle: handle,
                    author_name: authorName,
                    content: content,
                    tweet_url: tweetUrl,
                    published_at: publishedAt,
                    language: language,
                    attachments: attachments,
                });
            }
        } catch(e) { /* skip malformed tweet */ }
    }
    return JSON.stringify(tweets);
}"""


def _should_stop(tweets: list[dict], cursor: str | None, today_start_bjt: str, max_count: int) -> bool:
    """Check if we've hit the stop condition."""
    if not tweets:
        return False
    if cursor and any(t["tweet_id"] <= cursor for t in tweets):
        return True
    count = len(tweets)
    if count >= max_count:
        return True
    # Check if oldest tweet is before today 00:00 BJT
    oldest = min(tweets, key=lambda t: t.get("published_at", ""))
    if oldest.get("published_at") and oldest["published_at"] < today_start_bjt:
        return count >= max_count  # only stop if also past max
    return False


async def scrape_list(list_id: str, cursor: str | None = None) -> list[dict]:
    """Scrape new tweets from an X List.

    Stops when:
    - Reaches cursor (last_tweet_id from previous run)
    - max(100, tweets since today 00:00 BJT) tweets collected
    """
    url = f"https://x.com/i/lists/{list_id}"
    now_bjt = datetime.now(BJT)
    today_start = now_bjt.replace(hour=0, minute=0, second=0, microsecond=0)
    today_start_iso = today_start.isoformat()

    # Ensure pages dir
    PAGES_DIR.mkdir(parents=True, exist_ok=True)

    # Check for crash recovery
    existing_pages = sorted(PAGES_DIR.glob(f"{list_id}_page_*.json"))
    all_tweets = {}
    if existing_pages:
        for page_file in existing_pages:
            page_tweets = json.loads(page_file.read_text())
            for t in page_tweets:
                t["list_id"] = list_id
                all_tweets[t["tweet_id"]] = t
        print(f"Recovered {len(all_tweets)} tweets from {len(existing_pages)} cached pages")

    # Launch browser
    session = BrowserSession.from_system_chrome(
        profile_directory=CHROME_PROFILE,
        headless=False,
    )
    await session.start()

    try:
        # Inject x.com cookies
        cookies = extract_x_cookies()
        await inject_cookies(session, cookies)

        # Navigate to list
        await session.navigate_to(url)
        await asyncio.sleep(3)  # wait for initial load

        # Get list name from page
        page = await session.get_current_page()
        list_name = await page.evaluate("(...args) => { return document.title; }")

        page_num = len(existing_pages)
        no_new_count = 0

        while True:
            page_num += 1
            prev_count = len(all_tweets)

            # Extract tweets from current viewport
            raw = await page.evaluate(EXTRACT_JS)
            page_tweets = json.loads(raw) if raw else []

            new_count = 0
            for t in page_tweets:
                t["list_id"] = list_id
                if t["tweet_id"] not in all_tweets:
                    # Skip if before cursor
                    if cursor and t["tweet_id"] <= cursor:
                        continue
                    all_tweets[t["tweet_id"]] = t
                    new_count += 1

            print(f"Page {page_num}: extracted {len(page_tweets)}, new {new_count}, total {len(all_tweets)}")

            # Save page for crash recovery
            page_file = PAGES_DIR / f"{list_id}_page_{page_num:03d}.json"
            page_file.write_text(json.dumps(list(all_tweets.values()), ensure_ascii=False, indent=2))

            # Check stop conditions
            if cursor and any(t["tweet_id"] <= cursor for t in page_tweets):
                print(f"Reached cursor {cursor}, stopping")
                break

            tweet_list = list(all_tweets.values())
            count_limit = max(100, len([
                t for t in tweet_list
                if t.get("published_at", "") >= today_start_iso
            ]))
            if len(tweet_list) >= count_limit:
                print(f"Hit limit ({count_limit}), stopping")
                break

            if new_count == 0:
                no_new_count += 1
                if no_new_count >= MAX_SCROLL_RETRIES:
                    print("No new tweets after retries, stopping")
                    break
            else:
                no_new_count = 0

            # Scroll down
            mouse = await page.mouse
            await mouse.scroll(delta_y=800)
            await asyncio.sleep(SCROLL_PAUSE_SEC)

    finally:
        await session.kill()

    result = sorted(all_tweets.values(), key=lambda t: t["tweet_id"], reverse=True)

    # Clean up page cache
    for f in PAGES_DIR.glob(f"{list_id}_page_*.json"):
        f.unlink()

    return result, list_name
```

**Step 2: Verify** (manual test, requires browser)

Run: `cd ~/.claude/skills/xlist-scraper/scripts && ~/.browser-use-env/bin/python3 -c "
import asyncio
from list_scraper import scrape_list
tweets, name = asyncio.run(scrape_list('1643236611378008066'))
print(f'List: {name}, Tweets: {len(tweets)}')
if tweets: print(f'First: {tweets[0][\"author_handle\"]}: {tweets[0][\"content\"][:80]}')
"`

Expected: Opens Chrome, scrapes tweets, prints results.

---

### Task 4: Tweet Processor (filter + translate)

**Files:**
- Create: `~/.claude/skills/xlist-scraper/scripts/tweet_processor.py`

**Step 1: Write tweet_processor.py**

```python
"""Filter AI-related tweets and translate English to Chinese via DeepSeek."""
import re
import json
from openai import OpenAI
from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, AI_KEYWORDS, BATCH_TRANSLATE_SIZE

client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)


def _keyword_match(text: str) -> bool:
    """Fast filter: check if text contains AI-related keywords."""
    text_lower = text.lower()
    for kw in AI_KEYWORDS:
        if kw.lower() in text_lower:
            return True
    return False


def _llm_judge_ai_related(tweets: list[dict]) -> dict[str, bool]:
    """Slow filter: use LLM to judge ambiguous tweets."""
    if not tweets:
        return {}
    numbered = "\n".join(f"[{i}] @{t['author_handle']}: {t['content'][:200]}" for i, t in enumerate(tweets))
    resp = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=[
            {"role": "system", "content": "You are a classifier. For each tweet, reply ONLY with the index and Y (AI-related) or N (not). Example: 0:Y\n1:N\n2:Y"},
            {"role": "user", "content": f"Are these tweets related to AI, machine learning, LLMs, or artificial intelligence?\n\n{numbered}"},
        ],
        temperature=0,
        max_tokens=500,
    )
    result = {}
    for line in resp.choices[0].message.content.strip().split("\n"):
        m = re.match(r"(\d+)\s*:\s*([YN])", line.strip())
        if m:
            idx = int(m.group(1))
            if idx < len(tweets):
                result[tweets[idx]["tweet_id"]] = m.group(2) == "Y"
    return result


def filter_ai_related(tweets: list[dict]) -> list[dict]:
    """Two-pass filter: keyword fast path + LLM slow path."""
    passed = []
    uncertain = []

    for t in tweets:
        if _keyword_match(t["content"]):
            t["is_ai_related"] = True
            passed.append(t)
        else:
            uncertain.append(t)

    if uncertain:
        judgments = _llm_judge_ai_related(uncertain)
        for t in uncertain:
            is_ai = judgments.get(t["tweet_id"], False)
            t["is_ai_related"] = is_ai
            if is_ai:
                passed.append(t)

    return passed


def translate_batch(tweets: list[dict]) -> list[dict]:
    """Translate English tweets to Chinese in batches."""
    en_tweets = [t for t in tweets if t.get("language") != "zh" and t.get("content")]
    zh_tweets = [t for t in tweets if t.get("language") == "zh"]

    # Chinese tweets don't need translation
    for t in zh_tweets:
        t["translated"] = None

    # Batch translate English tweets
    for i in range(0, len(en_tweets), BATCH_TRANSLATE_SIZE):
        batch = en_tweets[i:i + BATCH_TRANSLATE_SIZE]
        numbered = "\n---\n".join(f"[{j}]\n{t['content']}" for j, t in enumerate(batch))

        resp = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=[
                {"role": "system", "content": (
                    "Translate each tweet to Chinese. Keep proper nouns (names, places, products) in English. "
                    "Output format: [N] followed by the translation. Preserve the numbering."
                )},
                {"role": "user", "content": numbered},
            ],
            temperature=0.3,
            max_tokens=4000,
        )

        translations = {}
        current_idx = None
        current_text = []
        for line in resp.choices[0].message.content.split("\n"):
            m = re.match(r"\[(\d+)\]\s*(.*)", line)
            if m:
                if current_idx is not None:
                    translations[current_idx] = "\n".join(current_text).strip()
                current_idx = int(m.group(1))
                current_text = [m.group(2)] if m.group(2) else []
            elif current_idx is not None:
                current_text.append(line)
        if current_idx is not None:
            translations[current_idx] = "\n".join(current_text).strip()

        for j, t in enumerate(batch):
            t["translated"] = translations.get(j, "")

    return tweets


def process_tweets(tweets: list[dict]) -> list[dict]:
    """Full pipeline: filter → translate → return AI-related tweets."""
    ai_tweets = filter_ai_related(tweets)
    if ai_tweets:
        translate_batch(ai_tweets)
    return ai_tweets
```

**Step 2: Verify** (unit-like test)

Run: `cd ~/.claude/skills/xlist-scraper/scripts && ~/.browser-use-env/bin/python3 -c "
from tweet_processor import _keyword_match
assert _keyword_match('New GPT-5 release!') == True
assert _keyword_match('I love pizza') == False
assert _keyword_match('大模型最新进展') == True
print('Keyword filter OK')
"`

Expected: `Keyword filter OK`

---

### Task 5: Output & Main Entry

**Files:**
- Create: `~/.claude/skills/xlist-scraper/scripts/output.py`
- Create: `~/.claude/skills/xlist-scraper/scripts/main.py`

**Step 1: Write output.py**

```python
"""Output module - pluggable emit interface."""
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from db import get_db, insert_tweets, mark_processed, mark_emitted, update_cursor, get_stats
from config import EXPORTS_DIR

BJT = timezone(timedelta(hours=8))


def save_to_db(tweets: list[dict], list_id: str):
    """Save raw tweets to database."""
    conn = get_db()
    insert_tweets(conn, tweets)
    conn.close()


def save_processed(tweets: list[dict]):
    """Update tweets with processing results."""
    conn = get_db()
    for t in tweets:
        mark_processed(conn, t["tweet_id"], t.get("is_ai_related", False), t.get("translated"))
    conn.close()


def update_list_cursor(list_id: str, tweets: list[dict]):
    """Update cursor to the newest tweet ID."""
    if not tweets:
        return
    newest_id = max(t["tweet_id"] for t in tweets)
    conn = get_db()
    update_cursor(conn, list_id, newest_id)
    conn.close()


def export_markdown(list_id: str, tweets: list[dict]) -> Path:
    """Export processed tweets to a markdown file."""
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(BJT)
    filename = f"{now.strftime('%Y-%m-%d')}-{list_id}.md"
    filepath = EXPORTS_DIR / filename

    lines = [f"# X List Scrape: {now.strftime('%Y-%m-%d %H:%M')} BJT\n"]
    lines.append(f"List ID: {list_id} | AI-related: {len(tweets)}\n")
    lines.append("---\n")

    for t in tweets:
        lines.append(f"## @{t['author_handle']} ({t['author_name']})")
        lines.append(f"*{t.get('published_at', '')}*\n")
        lines.append(f"**原文：**\n{t['content']}\n")
        if t.get("translated"):
            lines.append(f"**译文：**\n{t['translated']}\n")
        if t.get("attachments"):
            atts = json.loads(t["attachments"]) if isinstance(t["attachments"], str) else t["attachments"]
            for att in atts:
                lines.append(f"- [{att['type']}]({att['url']})")
            lines.append("")
        lines.append(f"[原始推文]({t['tweet_url']})\n")
        lines.append("---\n")

    filepath.write_text("\n".join(lines), encoding="utf-8")
    return filepath


def print_summary(list_id: str):
    conn = get_db()
    stats = get_stats(conn, list_id)
    conn.close()
    print(f"\n=== Scrape Summary ===")
    print(f"Total fetched: {stats['total']}")
    print(f"AI-related: {stats['ai_related']}")
    print(f"Not AI-related: {stats['not_ai_related']}")
    print(f"Processed: {stats['processed_count']}")
    print(f"Emitted: {stats['emitted_count']}")
```

**Step 2: Write main.py**

```python
"""xList Scraper - main entry point."""
import asyncio
import sys
import re
from db import get_db, upsert_list, get_cursor
from list_scraper import scrape_list
from tweet_processor import process_tweets
from output import save_to_db, save_processed, update_list_cursor, export_markdown, print_summary


def parse_list_id(arg: str) -> str:
    """Extract list ID from URL or raw ID."""
    m = re.search(r"lists/(\d+)", arg)
    if m:
        return m.group(1)
    if arg.isdigit():
        return arg
    raise ValueError(f"Cannot parse list ID from: {arg}")


async def run(list_id: str):
    print(f"=== xList Scraper ===")
    print(f"List ID: {list_id}")

    # Init DB
    conn = get_db()
    upsert_list(conn, list_id, url=f"https://x.com/i/lists/{list_id}")
    cursor = get_cursor(conn, list_id)
    conn.close()

    if cursor:
        print(f"Cursor: {cursor} (resuming from last run)")
    else:
        print("First run for this list (no cursor)")

    # Step 1: Scrape
    print("\n--- Scraping ---")
    tweets, list_name = await scrape_list(list_id, cursor)
    print(f"Scraped {len(tweets)} new tweets from '{list_name}'")

    if not tweets:
        print("No new tweets found.")
        return

    # Update list name
    conn = get_db()
    upsert_list(conn, list_id, name=list_name)
    conn.close()

    # Step 2: Save raw tweets
    save_to_db(tweets, list_id)

    # Step 3: Process (filter + translate)
    print("\n--- Processing ---")
    ai_tweets = process_tweets(tweets)
    print(f"AI-related: {len(ai_tweets)} / {len(tweets)}")

    # Step 4: Save processing results
    save_processed(ai_tweets)
    # Also mark non-AI tweets
    non_ai = [t for t in tweets if not t.get("is_ai_related")]
    from output import save_processed as sp
    for t in non_ai:
        t["is_ai_related"] = False
        t["translated"] = None
    save_processed(non_ai)

    # Step 5: Export
    if ai_tweets:
        md_path = export_markdown(list_id, ai_tweets)
        print(f"\nExported to: {md_path}")

    # Step 6: Update cursor
    update_list_cursor(list_id, tweets)

    # Step 7: Summary
    print_summary(list_id)


def main():
    if len(sys.argv) < 2:
        print("Usage: python main.py <list_id_or_url>")
        sys.exit(1)
    list_id = parse_list_id(sys.argv[1])
    asyncio.run(run(list_id))


if __name__ == "__main__":
    main()
```

**Step 3: Verify** (dry run parse test)

Run: `cd ~/.claude/skills/xlist-scraper/scripts && ~/.browser-use-env/bin/python3 -c "
from main import parse_list_id
assert parse_list_id('1643236611378008066') == '1643236611378008066'
assert parse_list_id('https://x.com/i/lists/1643236611378008066') == '1643236611378008066'
print('Parse OK')
"`

Expected: `Parse OK`

---

### Task 6: Skill Manifest & Project CLAUDE.md

**Files:**
- Create: `~/.claude/skills/xlist-scraper/SKILL.md`
- Create: `~/brain/30-projects/aifeeds/CLAUDE.md`

**Step 1: Write SKILL.md**

```markdown
---
name: xlist-scraper
description: Scrape X (Twitter) Lists for AI-related tweets, translate, and store in SQLite. Use when user says "抓取LIST", "scrape list", "xlist", or wants to fetch tweets from an X list.
---

# xList Scraper

Scrapes an X (Twitter) List, filters AI-related tweets, translates English→Chinese, stores in SQLite.

## Usage

```bash
# Run with list ID or URL
~/.browser-use-env/bin/python3 ${SKILL_DIR}/scripts/main.py <list_id_or_url>

# Examples:
~/.browser-use-env/bin/python3 ${SKILL_DIR}/scripts/main.py 1643236611378008066
~/.browser-use-env/bin/python3 ${SKILL_DIR}/scripts/main.py "https://x.com/i/lists/1643236611378008066"
```

If no argument is provided, use AskUserQuestion to ask for the List ID or URL.

## What It Does

1. Extracts x.com cookies from Chrome Default profile (auto-decrypt)
2. Launches Chrome via browser-use with Profile 1 + injected cookies
3. Scrolls the List timeline, extracts tweets until cursor/limit
4. Filters AI-related tweets (keyword + DeepSeek LLM)
5. Translates English tweets to Chinese (DeepSeek Chat)
6. Stores everything in SQLite at `~/brain/30-projects/aifeeds/data/xlist.db`
7. Exports AI-related tweets to markdown at `~/brain/30-projects/aifeeds/exports/`

## Data Location

- Database: `~/brain/30-projects/aifeeds/data/xlist.db`
- Exports: `~/brain/30-projects/aifeeds/exports/`

## Dependencies

- Python env: `~/.browser-use-env/` (Python 3.13 + browser-use + openai + cryptography)
- Chrome: with Default profile logged into x.com
- DeepSeek API key configured in scripts/config.py
```

**Step 2: Write CLAUDE.md**

```markdown
# xList Scraper

X (Twitter) List 抓取工具。自动抓取 List 中的 AI 相关推文，翻译英文为中文，存入 SQLite。

## 目录结构

```
data/
  xlist.db          SQLite 数据库（lists + tweets 表）
exports/
  YYYY-MM-DD-{list_id}.md   每次抓取导出的 markdown
docs/
  plans/            设计文档
```

## 使用方式

通过全局 skill `/xlist-scraper` 触发，或直接运行：

```bash
~/.browser-use-env/bin/python3 ~/.claude/skills/xlist-scraper/scripts/main.py <list_id>
```

## 技术要点

- Cookie 解密：从 Chrome Default profile 提取 x.com cookie（AES-128-CBC + macOS Keychain）
- 浏览器：browser-use Python API，用 Profile 1（轻量）+ 注入 Default 的 cookie
- 翻译/过滤：DeepSeek Chat API（OpenAI 兼容）
- 游标：基于 tweet snowflake ID，存在 lists 表的 last_cursor 字段
- 分页容错：每页暂存到 data/pages/，崩溃后自动恢复
```
```

---

## Execution

**Plan saved. Implementation approach:**

**Subagent-Driven (this session)** - dispatch fresh subagent per task, review between tasks.

Ready to start?

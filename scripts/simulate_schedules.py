"""对比三组抓取调度方案的回溯模拟。

数据切分：过去 28 天分两半 —— 前 14 天算 prior（训练），后 14 天跑模拟。
模拟中任意触发时刻 t 的 prior 来自训练期同 (BJT weekday, hour) 的 tweets/min。
recent = 模拟自身前 3 个触发的 new_count / interval。

指标：
  runs        抓取次数（越少越省）
  zero%       空跑占比（new_count=0 / runs，越低越好）
  avg/med     每次平均/中位收获条数
  cover%      被任一次抓到的推文占总数（仅用于判断最后一段漏了多少）
  max_gap     最长抓取间隔（分钟）
  p50/p95_del 发现延迟：每条推文从发布到被下一次抓取的时间差
"""

import bisect
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median

BJT = timezone(timedelta(hours=8))
DB = Path("/Users/roxor/brain/30-projects/aifeeds/data/xlist.db")
LIST_ID = "1643236611378008066"

TRAIN_DAYS = 14
SIM_DAYS = 14

MIN_INTERVAL_SEC = 600    # 10 min
MAX_INTERVAL_SEC = 5400   # 90 min
PRIOR_ALPHA = 0.5         # blend weight for prior vs recent


def load_tweet_unix_ts() -> list[float]:
    conn = sqlite3.connect(DB)
    cutoff = (datetime.now(BJT) - timedelta(days=TRAIN_DAYS + SIM_DAYS + 1)).isoformat()
    rows = conn.execute(
        "SELECT created_at FROM tweets WHERE list_id=? AND created_at >= ?",
        (LIST_ID, cutoff),
    ).fetchall()
    conn.close()
    out = []
    for (ts,) in rows:
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(BJT)
            out.append(dt.timestamp())
        except Exception:
            continue
    return sorted(out)


def build_prior_table(train_tweets_ts: list[float]) -> dict:
    """dict[(weekday, hour)] -> tweets/min over the training period."""
    counter: Counter = Counter()
    for ts in train_tweets_ts:
        dt = datetime.fromtimestamp(ts, BJT)
        counter[(dt.weekday(), dt.hour)] += 1
    weeks = TRAIN_DAYS / 7
    return {k: v / weeks / 60 for k, v in counter.items()}


def tweets_in_window(sorted_ts, start, end) -> int:
    lo = bisect.bisect_right(sorted_ts, start)
    hi = bisect.bisect_right(sorted_ts, end)
    return hi - lo


# ─── 调度策略 ──────────────────────────────────────────────

def _blended(prior, recent_counts, recent_mins):
    if not recent_mins or sum(recent_mins) <= 0:
        return prior
    recent = sum(recent_counts) / sum(recent_mins)
    return PRIOR_ALPHA * prior + (1 - PRIOR_ALPHA) * recent


def fixed_fn(interval_sec):
    def fn(ts, rc, rm, prior_tbl):
        return interval_sec
    return fn


def target_new_fn(target):
    def fn(ts, rc, rm, prior_tbl):
        dt = datetime.fromtimestamp(ts, BJT)
        prior = prior_tbl.get((dt.weekday(), dt.hour), 0)
        blended = _blended(prior, rc, rm)
        if blended <= 0.01:
            return MAX_INTERVAL_SEC
        sec = int((target / blended) * 60)
        return max(MIN_INTERVAL_SEC, min(MAX_INTERVAL_SEC, sec))
    return fn


def hybrid_hour_fn(hot_hours, hot_interval_sec, cold_target):
    """C1: 按 BJT 小时硬分区。热时段固定短间隔，冷时段 target_new 动态。"""
    def fn(ts, rc, rm, prior_tbl):
        dt = datetime.fromtimestamp(ts, BJT)
        if dt.hour in hot_hours:
            return hot_interval_sec
        prior = prior_tbl.get((dt.weekday(), dt.hour), 0)
        blended = _blended(prior, rc, rm)
        if blended <= 0.01:
            return MAX_INTERVAL_SEC
        sec = int((cold_target / blended) * 60)
        return max(MIN_INTERVAL_SEC, min(MAX_INTERVAL_SEC, sec))
    return fn


def hybrid_prior_fn(prior_threshold, hot_interval_sec, cold_target):
    """C2: 按当前 prior 判断热/冷。prior >= threshold 走固定短间隔。"""
    def fn(ts, rc, rm, prior_tbl):
        dt = datetime.fromtimestamp(ts, BJT)
        prior = prior_tbl.get((dt.weekday(), dt.hour), 0)
        if prior >= prior_threshold:
            return hot_interval_sec
        blended = _blended(prior, rc, rm)
        if blended <= 0.01:
            return MAX_INTERVAL_SEC
        sec = int((cold_target / blended) * 60)
        return max(MIN_INTERVAL_SEC, min(MAX_INTERVAL_SEC, sec))
    return fn


def ratio_fn(base_sec, baseline_prior):
    def fn(ts, rc, rm, prior_tbl):
        dt = datetime.fromtimestamp(ts, BJT)
        prior = prior_tbl.get((dt.weekday(), dt.hour), 0)
        blended = _blended(prior, rc, rm)
        if blended <= 0.01:
            return MAX_INTERVAL_SEC
        sec = int(base_sec * baseline_prior / blended)
        return max(MIN_INTERVAL_SEC, min(MAX_INTERVAL_SEC, sec))
    return fn


# ─── 模拟 + 评估 ───────────────────────────────────────────

def simulate(fn, sim_start, sim_end, prior_tbl, all_tweets):
    triggers = []
    t = sim_start
    rc, rm = [], []
    while t < sim_end:
        itv = fn(t, rc, rm, prior_tbl)
        nxt = t + itv
        if nxt > sim_end:
            break
        nc = tweets_in_window(all_tweets, t, nxt)
        triggers.append((nxt, nc, itv))
        rc = ([nc] + rc)[:3]
        rm = ([itv / 60] + rm)[:3]
        t = nxt
    return triggers


def compute_metrics(triggers, all_tweets, sim_start, sim_end):
    if not triggers:
        return None
    counts = [c for _, c, _ in triggers]
    intervals = [i for _, _, i in triggers]
    n = len(triggers)
    trigger_ts = sorted(t for t, _, _ in triggers)
    sim_tweets = [t for t in all_tweets if sim_start <= t < sim_end]
    total = len(sim_tweets)
    delays = []
    for ts in sim_tweets:
        idx = bisect.bisect_left(trigger_ts, ts)
        if idx < len(trigger_ts):
            delays.append(trigger_ts[idx] - ts)
    return {
        "runs": n,
        "zero_rate": sum(1 for c in counts if c == 0) / n,
        "avg_yield": sum(counts) / n,
        "med_yield": median(counts),
        "max_gap_min": max(intervals) / 60,
        "min_gap_min": min(intervals) / 60,
        "coverage": sum(counts) / total if total else 0,
        "p50_delay_min": median(delays) / 60 if delays else 0,
        "p95_delay_min": (sorted(delays)[int(len(delays) * 0.95)] / 60) if delays else 0,
    }


def main():
    all_tweets = load_tweet_unix_ts()
    now = datetime.now(BJT).timestamp()
    sim_end = now
    sim_start = sim_end - SIM_DAYS * 86400
    train_start = sim_start - TRAIN_DAYS * 86400
    train = [t for t in all_tweets if train_start <= t < sim_start]
    sim = [t for t in all_tweets if sim_start <= t < sim_end]
    prior = build_prior_table(train)

    print(f"Train window: {datetime.fromtimestamp(train_start, BJT):%Y-%m-%d %H:%M} → "
          f"{datetime.fromtimestamp(sim_start, BJT):%Y-%m-%d %H:%M}  ({len(train)} tweets)")
    print(f"Sim window:   {datetime.fromtimestamp(sim_start, BJT):%Y-%m-%d %H:%M} → "
          f"{datetime.fromtimestamp(sim_end, BJT):%Y-%m-%d %H:%M}  ({len(sim)} tweets)")
    print()

    strategies = [
        ("Fixed 30min (线上)", fixed_fn(1800)),
        ("Fixed 20min", fixed_fn(1200)),
        ("A: target_new=10 MAX=90m", target_new_fn(10)),
        ("A: target_new=5  MAX=90m", target_new_fn(5)),
    ]
    # 再加一组把 MAX 降到 60min 的实验
    global MAX_INTERVAL_SEC
    orig_max = MAX_INTERVAL_SEC
    header = f"{'Strategy':<38} {'runs':>5} {'zero%':>6} {'avg':>5} {'med':>4} {'cover%':>7} {'minGap':>7} {'maxGap':>7} {'p50del':>7} {'p95del':>7}"
    print(header)
    print("-" * len(header))
    for name, fn in strategies:
        tr = simulate(fn, sim_start, sim_end, prior, all_tweets)
        m = compute_metrics(tr, all_tweets, sim_start, sim_end)
        print(f"{name:<38} {m['runs']:>5} {m['zero_rate']*100:>5.1f}% "
              f"{m['avg_yield']:>5.1f} {m['med_yield']:>4.0f} "
              f"{m['coverage']*100:>6.1f}% "
              f"{m['min_gap_min']:>6.0f}m {m['max_gap_min']:>6.0f}m "
              f"{m['p50_delay_min']:>6.1f}m {m['p95_delay_min']:>6.1f}m")

    MAX_INTERVAL_SEC = 3600  # 60min
    hot_hours = set(range(22, 24)) | set(range(0, 8))  # BJT 22-08
    strategies2 = [
        ("A: target_new=10 MAX=60m", target_new_fn(10)),
        ("A: target_new=5  MAX=60m", target_new_fn(5)),
        ("B: ratio base=20m bl=0.10 MAX=60m", ratio_fn(1200, 0.10)),
        ("C1 hybrid-hour: BJT22-08=20m, else tgt10/90m",
            hybrid_hour_fn(hot_hours, 1200, 10)),
        ("C1 hybrid-hour: BJT22-08=30m, else tgt10/90m",
            hybrid_hour_fn(hot_hours, 1800, 10)),
        ("C2 hybrid-prior>=0.15: hot=20m, else tgt10",
            hybrid_prior_fn(0.15, 1200, 10)),
        ("C2 hybrid-prior>=0.10: hot=20m, else tgt10",
            hybrid_prior_fn(0.10, 1200, 10)),
        ("C2 hybrid-prior>=0.15: hot=30m, else tgt10",
            hybrid_prior_fn(0.15, 1800, 10)),
    ]
    for name, fn in strategies2:
        tr = simulate(fn, sim_start, sim_end, prior, all_tweets)
        m = compute_metrics(tr, all_tweets, sim_start, sim_end)
        print(f"{name:<46} {m['runs']:>5} {m['zero_rate']*100:>5.1f}% "
              f"{m['avg_yield']:>5.1f} {m['med_yield']:>4.0f} "
              f"{m['coverage']*100:>6.1f}% "
              f"{m['min_gap_min']:>6.0f}m {m['max_gap_min']:>6.0f}m "
              f"{m['p50_delay_min']:>6.1f}m {m['p95_delay_min']:>6.1f}m")
    MAX_INTERVAL_SEC = orig_max


if __name__ == "__main__":
    main()

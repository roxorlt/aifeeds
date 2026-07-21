import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Item, SearchGroup, SearchSuggestTerm } from "../../types";
import {
  searchItems,
  searchSuggest,
  classifySearchError,
  isRateLimited,
} from "../../api";
import { track, EVENTS } from "../../lib/telemetry";
import { toast } from "../../lib/toast";
import { SkeletonCard } from "../Feed";
import { ItemCard } from "../ItemCard";
import { SourceIcon } from "../icons";
import { browseSourceLabel, sourceFeedOrder } from "./sources";
import { HighlightProvider, extractHighlightTerms } from "./highlight";
import { RECALL_CAP, trackResultClick, chipBase } from "./searchResultShared";

// 分组结果页（?q= 无 source）：请求期 3 张 SkeletonCard；每组 = 组头（SourceIcon +
// 中文名 + 共 N 条 / 200+ + 更多 →）+ ≤3 张 ItemCard。卡片点击复用 ItemCard 内建
// drawer.openItem（navigate 深链，落到 DashboardHome 开抽屉，返回免费获得），本层
// 只额外埋 SEARCH_RESULT_CLICK。q 变化用 useEffect 响应（父级不 key 重建，返回链
// 逐级回退时本组件不重挂载）；快速换词靠 cancelled 丢弃过期响应防竞态。
interface SearchGroupsProps {
  q: string;
  submit: (q: string, opts: { source?: string; from: "history" | "hot" }) => void;
}

// 结果按「请求键」（retry 次数 + q）打标。渲染时 outcome 不属于当前请求键即视为
// loading —— 派生态，避免在 effect 内同步 setState 重置（既过 react-hooks/
// set-state-in-effect，又天然防竞态：过期 q 的响应键不匹配，永不上屏）。
type GroupsOutcome =
  | { key: string; kind: "ready"; groups: SearchGroup[] }
  | { key: string; kind: "empty" }
  | { key: string; kind: "error"; errKind: string };

export default function SearchGroups({ q, submit }: SearchGroupsProps) {
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<GroupsOutcome | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const reqKey = `${retryTick}:${q}`;
  const highlightTerms = useMemo(() => extractHighlightTerms(q), [q]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = performance.now();
    searchItems(q)
      .then((resp) => {
        if (cancelled) return;
        if (resp.mode !== "grouped") return; // 契约保证；防御性忽略非分组响应
        track(EVENTS.SEARCH_PERF, {
          server_ms: resp.query_time_ms,
          client_ms: Math.round(performance.now() - startedAt),
          mode: "grouped",
        });
        const nonEmpty = resp.groups.filter((g) => g.items.length > 0);
        if (nonEmpty.length === 0) {
          track(EVENTS.SEARCH_EMPTY, { q_len: q.length, mode: "grouped" });
          setOutcome({ key: reqKey, kind: "empty" });
        } else {
          setOutcome({ key: reqKey, kind: "ready", groups: nonEmpty });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const kind = classifySearchError(err);
        track(EVENTS.SEARCH_ERROR, { kind, mode: "grouped" });
        if (isRateLimited(err)) toast.error("搜索太频繁，请稍后再试");
        setOutcome({ key: reqKey, kind: "error", errKind: kind });
      });
    return () => {
      cancelled = true;
    };
  }, [q, retryTick, reqKey]);

  // outcome 不属于当前请求键 → 仍在加载（含首次、q 切换、retry）。
  if (!outcome || outcome.key !== reqKey) {
    return (
      <div data-search-state="grouped">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (outcome.kind === "error") {
    return (
      <div data-search-state="grouped">
        <SearchErrorBlock kind={outcome.errKind} onRetry={() => setRetryTick((t) => t + 1)} />
      </div>
    );
  }

  if (outcome.kind === "empty") {
    return (
      <div data-search-state="grouped">
        <SearchEmpty q={q} submit={submit} />
      </div>
    );
  }

  // 组序对齐 feed 列序（SOURCE_COLUMNS），组内 top3 仍按后端相关性顺序。
  // Array.prototype.sort 在 V8 稳定 → 同序组保持后端返回相对次序。
  const orderedGroups = [...outcome.groups].sort(
    (a, b) => sourceFeedOrder(a.source_type) - sourceFeedOrder(b.source_type),
  );

  // 高亮词从原始 q 提取；只包结果卡片区域（组头/更多按钮无 <HL>，不受影响）。
  return (
    <HighlightProvider terms={highlightTerms}>
    <div data-search-state="grouped" className="divide-y divide-neutral-200">
      {orderedGroups.map((group, groupIndex) => (
        <section key={group.source_type} className="py-2 first:pt-0">
          <header className="flex items-center justify-between gap-2 px-1 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <SourceIcon
                source_type={group.source_type}
                className="h-4 w-4 shrink-0 fill-current text-neutral-500"
              />
              <span className="text-sm font-medium text-neutral-900">
                {browseSourceLabel(group.source_type)}
              </span>
              <span className="text-[13px] text-neutral-400">
                共 {group.total >= RECALL_CAP ? "200+" : group.total} 条
              </span>
            </div>
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(group.source_type)}`,
                )
              }
              className="shrink-0 text-[13px] text-sky-600 transition-colors hover:text-sky-700"
            >
              更多 →
            </button>
          </header>
          <div>
            {group.items.slice(0, 3).map((item: Item, position) => (
              <div
                key={item.id}
                onClick={(e) => trackResultClick(e, item, position, groupIndex)}
              >
                <ItemCard item={item} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
    </HighlightProvider>
  );
}

// 行内错误块：429 已弹 toast，这里给「搜索太频繁」+ 重试；其它错误给「搜索暂时不
// 可用」+ 重试。neutral 沉静，重试按钮 rounded-md border。文案与 toast 保持一致。
export function SearchErrorBlock({
  kind,
  onRetry,
}: {
  kind: string;
  onRetry: () => void;
}) {
  const rateLimited = kind === "rate_limited";
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-sm text-neutral-600">
        {rateLimited ? "搜索太频繁，请稍后再试" : "搜索暂时不可用"}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-neutral-300 px-4 py-1.5 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-50"
      >
        重试
      </button>
    </div>
  );
}

// 全空空态：沉静文案 + 换词提示 + 热搜 chips（点击走父级 submit：写历史 + 埋点 +
// 跳转）。热搜取 suggest 空 prefix top10，失败/空整段不渲染。
function SearchEmpty({
  q,
  submit,
}: {
  q: string;
  submit: (q: string, opts: { source?: string; from: "history" | "hot" }) => void;
}) {
  const [hot, setHot] = useState<SearchSuggestTerm[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const terms = await searchSuggest("");
        if (!cancelled) setHot(terms.slice(0, 10));
      } catch {
        /* 失败静默：不渲染热搜 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-sm text-neutral-700">没有找到与「{q}」相关的内容</p>
      <p className="text-[13px] text-neutral-500">换个关键词试试</p>
      {hot.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {hot.map((t) => (
            <button
              key={`${t.term_type}:${t.term}`}
              type="button"
              onClick={() => submit(t.term, { from: "hot" })}
              className={chipBase}
            >
              <span className="min-w-0 max-w-[12rem] truncate">{t.term}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

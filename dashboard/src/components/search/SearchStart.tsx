import { useEffect, useState, type ReactNode } from "react";
import { SourceIcon } from "../icons";
import { searchSuggest } from "../../api";
import {
  getSearchHistory,
  removeSearchHistory,
  clearSearchHistory,
} from "../../lib/searchHistory";
import { BROWSE_SOURCES } from "./sources";
import type { SearchSuggestTerm } from "../../types";

// 起始态三区块：搜索历史 / 大家在搜 / 按来源浏览。
// - 历史：localStorage（LRU 20），单删 + 清空 confirm；空则整块不渲染。
// - 大家在搜：searchSuggest("") 的 top10；接口空/失败整块不渲染。
// - 按来源浏览：只放当前真实存在且 search 合法的单源（worker LEGAL_SOURCES）。
//   「新闻&播客」在 items 表是复合频道值 "blog,podcast"，但 search source 参数只吃
//   单值，故拆成「新闻」(blog) 与「播客」(podcast) 两枚 chip，其余与顶栏频道口径一致。
interface SearchStartProps {
  submit: (q: string, opts: { source?: string; from: "history" | "hot" }) => void;
  onPickSource: (source: string) => void;
}

const chipBase =
  "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1 text-[13px] text-neutral-700 transition-colors hover:bg-neutral-200";

function SectionTitle({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-[13px] font-medium text-neutral-500">{children}</h2>
      {action}
    </div>
  );
}

export default function SearchStart({ submit, onPickSource }: SearchStartProps) {
  // 惰性初始化：挂载时读一次 localStorage（避免 effect 内同步 setState 触发级联渲染）。
  const [history, setHistory] = useState<string[]>(() => getSearchHistory());
  const [hot, setHot] = useState<SearchSuggestTerm[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const terms = await searchSuggest("");
        if (!cancelled) setHot(terms.slice(0, 10));
      } catch {
        /* 失败静默：不渲染「大家在搜」 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function delOne(term: string) {
    removeSearchHistory(term);
    setHistory((prev) => prev.filter((x) => x !== term));
  }

  function clearAll() {
    if (!window.confirm("清空全部搜索历史？")) return;
    clearSearchHistory();
    setHistory([]);
  }

  return (
    <div>
      {/* 1. 搜索历史 —— 空则整块隐藏 */}
      {history.length > 0 && (
        <section className="mb-6">
          <SectionTitle
            action={
              <button
                type="button"
                onClick={clearAll}
                className="text-[13px] text-neutral-500 transition-colors hover:text-neutral-700"
              >
                清空
              </button>
            }
          >
            搜索历史
          </SectionTitle>
          <div className="flex flex-wrap gap-2">
            {history.map((term) => (
              <span key={term} className={chipBase}>
                <button
                  type="button"
                  onClick={() => submit(term, { from: "history" })}
                  className="min-w-0 max-w-[12rem] truncate"
                >
                  {term}
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${term}`}
                  onClick={() => delOne(term)}
                  className="-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:text-neutral-600"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 2. 大家在搜 —— 接口空/失败整块隐藏 */}
      {hot.length > 0 && (
        <section className="mb-6">
          <SectionTitle>大家在搜</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {hot.map((t) => (
              <button
                key={`${t.term_type}:${t.term}`}
                type="button"
                onClick={() => submit(t.term, { from: "hot" })}
                className={chipBase}
              >
                <span className="min-w-0 max-w-[12rem] truncate">{t.term}</span>
                {t.term_type === "hot_query" && (
                  <span className="shrink-0 rounded bg-white/70 px-1 text-[11px] font-medium text-neutral-500">
                    热
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 3. 按来源浏览 —— 点击预选该源并聚焦输入框（提交后直进单源 list 模式） */}
      <section className="mb-6">
        <SectionTitle>按来源浏览</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {BROWSE_SOURCES.map(({ source, label }) => (
            <button
              key={source}
              type="button"
              onClick={() => onPickSource(source)}
              className={chipBase}
            >
              <SourceIcon
                source_type={source}
                className="h-3.5 w-3.5 shrink-0 fill-current text-neutral-500"
              />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

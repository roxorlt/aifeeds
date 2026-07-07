import { useEffect, useRef, useState, type RefObject } from "react";
import { IconSearch } from "../icons";
import { searchSuggest } from "../../api";
import type { SearchSuggestTerm } from "../../types";

// C 端搜索输入框（受控）+ suggestion 下拉。
// - 受控：value / onValueChange 由父级持有（父级同时管理「预选源」等外部状态）。
// - 提交：回车 → onSubmit(value, "typed")；点 suggestion → onSubmit(term, "suggest")。
//   （父级 SearchPage 的 submitQuery 负责 addSearchHistory + track + navigate，
//    并按当前预选源决定 grouped / list 模式。）
// - 防抖 250ms 调 searchSuggest，AbortController 取消在途；每个 effect run 独立
//   closure（cancelled + ctrl.abort），旧响应绝不覆盖新输入（竞态见文件尾注）。
// - IME：composition 期间回车确认候选不触发提交（compositionstart/end + isComposing）。
// - 失败静默：searchSuggest 对超限/出错返回空数组，异常在此 catch 吞掉，不渲染下拉。
interface SearchInputProps {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit: (q: string, from: "typed" | "suggest") => void;
  onCancel?: () => void;
  showCancel?: boolean;
  placeholder?: string;
  // 父级持有，用于「按来源浏览」chip 点击后聚焦、清空 ✕ 后回焦。
  inputRef?: RefObject<HTMLInputElement | null>;
}

const DEBOUNCE_MS = 250;

export default function SearchInput({
  value,
  onValueChange,
  onSubmit,
  onCancel,
  showCancel = false,
  placeholder = "请输入关键词",
  inputRef,
}: SearchInputProps) {
  const localRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? localRef;

  const [suggestions, setSuggestions] = useState<SearchSuggestTerm[]>([]);
  const [open, setOpen] = useState(false);
  const composingRef = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 防抖 + AbortController 取消在途。每次 value 变化：cleanup 先 abort 上一在途请求、
  // 清 debounce 定时器、置 cancelled=true（阻止过期响应 setState）。新一轮独立 closure。
  // 注：value 清空时的下拉收起在事件处理器里做（onChange / clear），effect 内不同步
  // setState（避免级联渲染，react-hooks 规则）；showDropdown 还叠了 value.trim() 门槛兜底。
  useEffect(() => {
    const q = value.trim();
    if (!q) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const terms = await searchSuggest(q, ctrl.signal);
        if (cancelled) return; // 更新的输入已开新一轮，丢弃本次结果
        setSuggestions(terms);
        setOpen(terms.length > 0);
      } catch {
        /* AbortError / 网络异常：静默，不渲染下拉 */
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [value]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  function submitTyped() {
    if (composingRef.current) return; // IME 组合中，回车是确认候选，不提交
    setOpen(false);
    onSubmit(value, "typed");
  }

  function pickSuggestion(term: string) {
    setOpen(false);
    onSubmit(term, "suggest");
  }

  function clear() {
    onValueChange("");
    setSuggestions([]);
    setOpen(false);
    ref.current?.focus();
  }

  const showDropdown = open && suggestions.length > 0 && value.trim() !== "";

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          ref={ref}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={value}
          maxLength={50}
          placeholder={placeholder}
          aria-label="搜索关键词"
          autoComplete="off"
          className="w-full rounded-md border border-neutral-300 bg-white py-2 pl-9 pr-9 text-base placeholder:text-sm placeholder:text-neutral-400 transition-colors focus:border-neutral-900 focus:outline-none"
          onChange={(e) => {
            const v = e.target.value;
            if (!v.trim()) {
              // 清空（含全选删除）：立即收下拉、丢旧候选（effect 只负责非空分支）
              setSuggestions([]);
              setOpen(false);
            }
            onValueChange(v);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // IME 三重保险：composingRef（compositionstart/end 标记）+ isComposing
              //（Chrome/Firefox 确认候选的 Enter 上为 true）+ keyCode 229（Safari 在
              // compositionend 先于 keydown 的时序下，确认键 keyCode 仍报 229）。
              if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              submitTyped();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            if (suggestions.length > 0) setOpen(true);
          }}
          onBlur={() => {
            // 延迟关闭，给 suggestion 的 mousedown/click 留出触发窗口
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
        />
        {value && (
          <button
            type="button"
            aria-label="清空"
            onClick={clear}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600"
          >
            ✕
          </button>
        )}

        {showDropdown && (
          <ul
            role="listbox"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
          >
            {suggestions.map((s) => (
              <li key={`${s.term_type}:${s.term}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  // mousedown preventDefault：先于 input blur 触发，避免下拉被 blur 关闭吞掉点击
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSuggestion(s.term)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-50"
                >
                  <IconSearch className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                  <span className="min-w-0 flex-1 truncate">{s.term}</span>
                  {s.term_type === "hot_query" && (
                    <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500">
                      热
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 px-1 text-sm text-neutral-600 transition-colors hover:text-neutral-900"
        >
          取消
        </button>
      )}
    </div>
  );
}

// 竞态说明：debounce + abort 用「per-effect-run closure」保证正确性。value 每变一次，
// React 先跑上一 run 的 cleanup（cancelled=true 挡掉过期 setState、ctrl.abort() 掐掉在途
// fetch、clearTimeout 撤未触发的防抖），再跑新 run。因此任一时刻最多一个在途请求，且
// 过期请求即便先返回也进不了 setState —— 旧响应不会覆盖新输入的结果。

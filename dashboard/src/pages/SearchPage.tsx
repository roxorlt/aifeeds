import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useIsNarrow } from "../lib/breakpoint";
import { addSearchHistory } from "../lib/searchHistory";
import { track, EVENTS } from "../lib/telemetry";
import { DrawerProvider } from "../lib/drawer";
import { SourceIcon } from "../components/icons";
import SearchInput from "../components/search/SearchInput";
import SearchStart from "../components/search/SearchStart";
import SearchGroups from "../components/search/SearchGroups";
import SearchSourceList from "../components/search/SearchSourceList";
import { browseSourceLabel } from "../components/search/sources";

// C 端搜索页（公开，不包 RequireAuth）。
//
// Task 10 填「起始态 + 输入态」：SearchInput（受控 + 防抖 suggestion）+ SearchStart
// （历史 / 大家在搜 / 按来源浏览）。分组结果（grouped）与单源流（list）仍是占位，Task 11 接手。
//
// noindex：搜索结果页不应进搜索引擎索引。robots 层面归 SEO 计划统一处理
// （worker 生成的 robots.txt / meta robots）；此处仅设 document.title 作页面标识，
// 并留此注释标记 /search 需 noindex，供 SEO 计划接手时对齐。
export default function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const q = params.get("q")?.trim() ?? "";
  const source = params.get("source")?.trim() ?? "";

  useEffect(() => {
    document.title = "搜索 - AI-Feeds";
  }, []);

  // ── 提交动作统一入口 ───────────────────────────────────────────────
  // 任何来源（typed / suggest / history / hot）最终都走这里：写历史 + 埋点 + 跳转。
  // 带 source → list 模式（单源流），否则 grouped（分组预览）。
  const submitQuery = useCallback(
    (raw: string, opts: { source?: string; from: "typed" | "suggest" | "history" | "hot" }) => {
      const t = raw.trim();
      if (!t) return;
      addSearchHistory(t);
      track(EVENTS.SEARCH_SUBMIT, {
        q_len: t.length,
        from: opts.from,
        mode: opts.source ? "list" : "grouped",
      });
      const p = new URLSearchParams({ q: t });
      if (opts.source) p.set("source", opts.source);
      navigate(`/search?${p.toString()}`);
    },
    [navigate],
  );

  // 三态：无 q → 起始页；有 q 无 source → 分组预览；有 q + source → 单源流。
  if (!q) {
    return <SearchStartView narrow={narrow} submit={submitQuery} onCancel={() => navigate(-1)} />;
  }

  // 结果页需 DrawerProvider：ItemCard 各源卡片内部 useDrawer() 打开抽屉，而 /search
  // 路由不在 DashboardHome 的 DrawerProvider 内。卡片点击 → drawer.openItem →
  // navigate 到 /t/:id 等深链（本组件随即卸载，落到 DashboardHome 由其 DrawerProvider
  // 渲染真正的抽屉）；fetchItem 的模块级 single-flight 让新 Provider 加入搜索页已经
  // 发出的同 id 详情 GET，不会因 Provider 切换重复请求。返回键逐级回退免费获得。
  // q/source 变化经 useSearchParams →
  // SearchGroups/SearchSourceList 的 useEffect 响应，父级不 key 重建，popstate 不重挂载。
  return (
    <DrawerProvider>
      <div className="mx-auto max-w-[720px] px-4 py-6 text-neutral-700">
        {!source ? (
          <SearchGroups q={q} submit={submitQuery} />
        ) : (
          <SearchSourceList q={q} source={source} />
        )}
      </div>
    </DrawerProvider>
  );
}

// 起始态视图：移动端全屏（顶部输入行含「取消」返回），PC 居中 max-w-2xl。
function SearchStartView({
  narrow,
  submit,
  onCancel,
}: {
  narrow: boolean;
  submit: (q: string, opts: { source?: string; from: "typed" | "suggest" | "history" | "hot" }) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  // 「按来源浏览」预选的源：设后 typed/suggest 提交直进该源 list 模式。
  const [scopeSource, setScopeSource] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 起始态自动聚焦。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onInputSubmit = useCallback(
    (raw: string, from: "typed" | "suggest") => {
      submit(raw, { source: scopeSource ?? undefined, from });
    },
    [submit, scopeSource],
  );

  const pickSource = useCallback((s: string) => {
    setScopeSource(s);
    inputRef.current?.focus();
  }, []);

  const header = (
    <div>
      <SearchInput
        value={value}
        onValueChange={setValue}
        onSubmit={onInputSubmit}
        onCancel={onCancel}
        showCancel={narrow}
        inputRef={inputRef}
      />
      {scopeSource && (
        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-neutral-500">
          <span>在</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-700">
            <SourceIcon
              source_type={scopeSource}
              className="h-3.5 w-3.5 shrink-0 fill-current text-neutral-500"
            />
            {browseSourceLabel(scopeSource)}
            <button
              type="button"
              aria-label="取消来源筛选"
              onClick={() => {
                setScopeSource(null);
                inputRef.current?.focus();
              }}
              className="-mr-0.5 flex h-4 w-4 items-center justify-center rounded text-neutral-400 transition-colors hover:text-neutral-600"
            >
              ✕
            </button>
          </span>
          <span>中搜索</span>
        </div>
      )}
    </div>
  );

  const blocks = <SearchStart submit={submit} onPickSource={pickSource} />;

  if (narrow) {
    return (
      <div data-search-state="start" className="flex min-h-screen flex-col bg-white">
        <div className="sticky top-0 z-10 border-b border-neutral-200 bg-white px-4 py-3">
          {header}
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 text-neutral-700">{blocks}</div>
      </div>
    );
  }

  return (
    <div data-search-state="start" className="mx-auto max-w-2xl px-4 py-6 text-neutral-700">
      <div className="mb-6">{header}</div>
      {blocks}
    </div>
  );
}

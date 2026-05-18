// HF Daily Paper Phase 0 mockup 展示页 — 自包含 demo
//
// 访问路径：`/mockup/hf`
//
// 这页是给 PM / BE 看视觉效果用的 design mockup，不接 BE 数据。
// 上线 BE Phase 1-7 真接口后，整个文件 + mockData/hfPapers.ts + 路由 + 注释
// 一起删除。
//
// 实现方式：
//   - 用自己的本地 state（selectedId）模拟 drawer，不走 react-router 导航
//   - HfPaperCard 内部 useDrawer().openItem() 会读到这里 inject 的 mock context
//     而不是真实 DrawerProvider 的 navigate（避免触发 fetchItem 404）
//   - 不嵌套真实 DrawerProvider，因此关掉 drawer 不会污染 URL

import { useMemo, useState } from "react";
import type { Item, ItemExtra } from "../types";
import { parseJsonField } from "../lib/utils";
import { DrawerContext } from "../lib/drawer";
import { MOCK_HF_PAPERS } from "../mockData/hfPapers";
import {
  aggregatePrimaryCategories,
  arxivCategoryOptionLabel,
} from "../lib/arxivCategories";
import { HfPaperCard } from "./HfPaperCard";
import { HfPaperDrawerBody } from "./HfPaperDrawerBody";

function paperCategories(item: Item): string[] {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  return (extra.arxiv_categories as string[] | undefined) ?? [];
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function HfPaperMockupPage() {
  const [selectedId, setSelectedId] = useState<string | null>(
    MOCK_HF_PAPERS[0]?.id ?? null,
  );
  // 分类筛选 — "" = 全部,非空 = 仅显示 primary category 匹配的卡片
  const [categoryFilter, setCategoryFilter] = useState<string>("");

  // 聚合 mock data 里出现的 primary categories 作下拉 options(线上是
  // 服务端聚合,这里前端聚合 mock 演示)
  const availableCategories = useMemo(
    () =>
      aggregatePrimaryCategories(
        MOCK_HF_PAPERS.map((p) => ({
          arxiv_categories: paperCategories(p),
        })),
      ),
    [],
  );

  // 按 categoryFilter 过滤
  const visiblePapers = useMemo(
    () =>
      categoryFilter === ""
        ? MOCK_HF_PAPERS
        : MOCK_HF_PAPERS.filter((p) => paperCategories(p)[0] === categoryFilter),
    [categoryFilter],
  );

  const selected = useMemo(
    () => MOCK_HF_PAPERS.find((p) => p.id === selectedId) ?? null,
    [selectedId],
  );

  // Mock DrawerContext value —— 仅实现 mockup page 需要的 openItem 与 close。
  // 其余字段（openTweet / spotlightItem / clearSpotlight）给空实现，类型对齐而已。
  const mockDrawerValue = useMemo(
    () => ({
      state: {
        item: selected,
        siblings: [] as Item[],
        loading: false,
        error: null,
      },
      openTweet: () => {},
      openItem: (item: Item) => setSelectedId(item.id),
      close: () => setSelectedId(null),
      spotlightItem: null,
      clearSpotlight: () => {},
    }),
    [selected],
  );

  return (
    <DrawerContext.Provider value={mockDrawerValue}>
      <div className="min-h-screen bg-neutral-50/40">
        {/* Header — 标识这是 mockup 页，PM / BE 一打开就知道是 design 演示 */}
        <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/95 backdrop-blur">
          <div className="mx-auto max-w-7xl px-5 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-[16px] font-bold text-neutral-900">
                  HuggingFace Daily Papers · Phase 0 mockup
                </h1>
                <p className="mt-0.5 text-[12px] text-neutral-500">
                  设计稿演示页，等 BE Phase 1-7 上线后由
                  <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-[11px] font-mono">/h/:arxiv_id</code>
                  接管。数据全部 mock，无 backend 调用。
                </p>
              </div>
              <a
                href="/"
                className="shrink-0 text-[12px] text-sky-600 hover:underline"
              >
                ← 返回首页
              </a>
            </div>
          </div>
        </header>

        {/* 主区：左 cards 流（按线上 lg 屏 3-col 单列约 380px），右 drawer 详情 */}
        <div className="mx-auto flex max-w-[1280px] gap-0 px-0 lg:px-5">
          {/* 左列：5 张卡片 — 对齐线上 max-w-[1280px] / 3-col / gap-4 的单列约 380px */}
          <div className="w-full max-w-[400px] shrink-0 border-x border-neutral-200 bg-white lg:border-l-0">
            <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50/60 px-4 py-2 text-[12px] font-medium text-neutral-500">
              <span>
                卡片视图 · {visiblePapers.length} / {MOCK_HF_PAPERS.length} 条
              </span>
              {/* arxiv categories 真实下拉筛选(本 mockup 前端 filter;线上由
                  BE API 加 ?category= 参数做服务端筛选,handoff §6 决议 #2) */}
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-700 hover:border-neutral-400 focus:border-sky-500 focus:outline-none"
                title="按论文 arxiv primary category 筛选"
              >
                <option value="">全部分类</option>
                {availableCategories.map(({ code, count }) => (
                  <option key={code} value={code}>
                    {arxivCategoryOptionLabel(code)} · {count}
                  </option>
                ))}
              </select>
            </div>
            {visiblePapers.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] text-neutral-400">
                当前分类下无论文 — 清空筛选看全部
              </div>
            ) : (
              visiblePapers.map((item) => (
                <div
                  key={item.id}
                  className={
                    selectedId === item.id
                      ? "bg-sky-50/40 ring-1 ring-inset ring-sky-200"
                      : ""
                  }
                >
                  <HfPaperCard item={item} />
                </div>
              ))
            )}
          </div>

          {/* 右列：选中卡片的 drawer body，sticky 跟左列滚动 */}
          <div className="hidden flex-1 border-r border-neutral-200 bg-white lg:block">
            {selected ? (
              <div className="sticky top-[57px] max-h-[calc(100vh-57px)] overflow-y-auto">
                <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50/60 px-4 py-2 text-[12px] font-medium text-neutral-500">
                  <span>抽屉详情视图 · {selected.extra && typeof selected.extra === "object" && "arxiv_id" in selected.extra ? `arxiv:${selected.extra.arxiv_id}` : selected.id}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="inline-flex items-center gap-1 rounded p-1 text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600"
                    aria-label="关闭详情"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </div>
                <HfPaperDrawerBody item={selected} />
              </div>
            ) : (
              <div className="flex h-[calc(100vh-57px)] items-center justify-center px-5 text-center text-[13px] text-neutral-400">
                点击左侧卡片查看抽屉详情
              </div>
            )}
          </div>
        </div>

        {/* 窄屏 fallback 提示 — drawer 改成 modal 形式 */}
        {selected && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setSelectedId(null)}
            />
            <div className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50/60 px-4 py-2 text-[12px] font-medium text-neutral-500">
                <span>抽屉详情</span>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="inline-flex items-center gap-1 rounded p-1 text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600"
                  aria-label="关闭详情"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </div>
              <HfPaperDrawerBody item={selected} />
            </div>
          </div>
        )}
      </div>
    </DrawerContext.Provider>
  );
}

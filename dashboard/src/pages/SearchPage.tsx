import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router";

// C 端搜索页（公开，不包 RequireAuth）。
//
// 本任务（Task 8）只搭三态骨架 —— 读 ?q= / &source=，渲染起始 / 分组 / 单源占位，
// 真实内容（起始页 suggestion、分组结果、单源流、空/错态、埋点）由 Task 10/11 填充。
//
// noindex：搜索结果页不应进搜索引擎索引。robots 层面归 SEO 计划统一处理
// （worker 生成的 robots.txt / meta robots）；此处仅设 document.title 作页面标识，
// 并留此注释标记 /search 需 noindex，供 SEO 计划接手时对齐。
export default function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const source = params.get("source")?.trim() ?? "";

  useEffect(() => {
    document.title = "搜索 - AI-Feeds";
  }, []);

  // 三态：无 q → 起始页；有 q 无 source → 分组预览；有 q + source → 单源流。
  let body: ReactNode;
  if (!q) {
    body = <div data-search-state="start">起始页占位（Task 10：热搜 / 历史 / suggestion）</div>;
  } else if (!source) {
    body = (
      <div data-search-state="grouped">
        分组结果占位（Task 11）：q = {q}
      </div>
    );
  } else {
    body = (
      <div data-search-state="list">
        单源结果占位（Task 11）：q = {q} / source = {source}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] px-4 py-6 text-neutral-700">
      {body}
    </div>
  );
}

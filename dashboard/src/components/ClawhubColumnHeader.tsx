// ClawHub 专属列头筛选器（替代全局 SortSelector 的「热度|时间」toggle）
// Per design doc § 5.2 + mockup：3 控件水平一行 — 排序 select / 分类 select / 隐藏可疑 toggle
// 隐藏可疑：worker 端默认已经过滤（phase 1 fetch 时 `nonSuspiciousOnly=true`），
// 所以这个 toggle 是 read-only 提示，不实际改 API 请求

export type ClawhubSort = "stars" | "downloads" | "installs" | "updated" | "name";
export type ClawhubCategory =
  | "all"
  | "mcp-tools"
  | "prompts"
  | "workflows"
  | "dev-tools"
  | "data"
  | "security"
  | "automation"
  | "other";

const SORT_OPTIONS: { value: ClawhubSort; label: string }[] = [
  { value: "stars", label: "星标数" },
  { value: "downloads", label: "下载量" },
  { value: "installs", label: "安装量" },
  { value: "updated", label: "最近更新" },
  { value: "name", label: "名称 A-Z" },
];

const CATEGORY_OPTIONS: { value: ClawhubCategory; label: string }[] = [
  { value: "all", label: "全部分类" },
  { value: "mcp-tools", label: "MCP 工具" },
  { value: "prompts", label: "Prompts" },
  { value: "workflows", label: "Workflows" },
  { value: "dev-tools", label: "Dev 工具" },
  { value: "data", label: "数据 & API" },
  { value: "security", label: "安全" },
  { value: "automation", label: "自动化" },
  { value: "other", label: "其他" },
];

interface Props {
  sort: ClawhubSort;
  category: ClawhubCategory;
  hideSuspicious: boolean;
  onSortChange: (s: ClawhubSort) => void;
  onCategoryChange: (c: ClawhubCategory) => void;
  onHideSuspiciousChange: (b: boolean) => void;
}

// 高度策略（修对齐）：所有控件共用 H=22px，分两层
//   - 外层 wrapper：`inline-flex h-[22px] items-center` — 强约束高度，不依赖原生 select 渲染
//   - 内层 select：`h-full` 撑满外层；之前直接给 select h-[22px] 在 Safari/iOS 不一定生效
//     （native select 有 user-agent 默认 line-height/padding，h-* 偶尔被覆盖），所以下推到 h-full
const SELECT_CLASS =
  "h-full appearance-none rounded border border-neutral-300 bg-white pl-1.5 pr-4 box-border text-[10.5px] leading-none text-neutral-700 cursor-pointer hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300";
const CHEVRON_CLASS =
  "absolute right-1 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-neutral-400 pointer-events-none";
const WRAPPER_CLASS = "relative inline-flex h-[22px] items-center";

export function ClawhubColumnHeader({ sort, category, hideSuspicious, onSortChange, onCategoryChange, onHideSuspiciousChange }: Props) {
  return (
    <div className="flex items-center gap-1">
      {/* 排序 */}
      <div className={WRAPPER_CLASS}>
        <select
          value={sort}
          onChange={(e) => {
            e.stopPropagation();
            onSortChange(e.target.value as ClawhubSort);
          }}
          onClick={(e) => e.stopPropagation()}
          className={SELECT_CLASS}
          title="排序"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={CHEVRON_CLASS}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* 分类 */}
      <div className={WRAPPER_CLASS}>
        <select
          value={category}
          onChange={(e) => {
            e.stopPropagation();
            onCategoryChange(e.target.value as ClawhubCategory);
          }}
          onClick={(e) => e.stopPropagation()}
          className={SELECT_CLASS}
          title="分类"
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={CHEVRON_CLASS}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* 隐藏可疑 toggle — 跟 select 同 h-[22px] + box-border + 同样的 inline-flex 容器规则 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onHideSuspiciousChange(!hideSuspicious);
        }}
        className={`inline-flex items-center justify-center h-[22px] w-[22px] box-border rounded border transition-colors ${
          hideSuspicious
            ? "bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
            : "bg-neutral-50 border-neutral-200 text-neutral-400 hover:bg-neutral-100"
        }`}
        title={hideSuspicious ? "已隐藏可疑 skill — 点击关闭过滤" : "正显示全部 skill（含可疑）— 点击重新过滤"}
        aria-pressed={hideSuspicious}
      >
        <svg
          viewBox="0 0 24 24"
          fill={hideSuspicious ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-2.5 h-2.5"
        >
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        </svg>
      </button>
    </div>
  );
}

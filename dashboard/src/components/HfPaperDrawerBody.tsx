// HuggingFace Daily Paper drawer body — Phase 0 mockup v3 (PM 2.x feedback)
//
// 结构(常驻区 + 关键词下方 tabs 切换):
//   [Hero]       thumbnail 1200×630 + 标题中英 + by @xxx 等 N 位提交
//   [摘要]       译/原 toggle + 复制 (PM 2.3: 上移到 by 张三下方)
//   [数据]       KPI 4-col (upvotes / comments / GH stars / 作者数)
//   [作者列表]   折叠(默认 5 个 + 展开 +N)
//   [关键词]     全部 chip
//   ─── Tabs ─── (PM 2.2: 下移到关键词下方)
//   | 原始信息 | 拆解阅读 |
//
//   原始信息 tab:
//     - 全文翻译 (Phase 2 ar5iv,当前 placeholder + ar5iv link)
//     - 评论 (PM 2.4: 改名"评论",位置在全文下、外链上;待 BE v1 接入)
//     - 外部链接 (arxiv + PDF + GitHub + 项目主页;砍 HF)
//
//   拆解阅读 tab:
//     - TL;DR (轻量 callout,border-l-4 neutral-300)
//     - 7 维度长文(BE Phase 4 改 prompt 后承载 200-500 字深度内容)

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import type { Components } from "react-markdown";
import type {
  HfCodeStatus,
  HfDiscussionComment,
  HfPaperMetrics,
  Item,
  ItemExtra,
} from "../types";
import { formatCompact, parseJsonField, timeAgo } from "../lib/utils";
import { resolveAssetUrl } from "../lib/asset";
import { useIsNarrow } from "../lib/breakpoint";

// 评论 HTML 渲染走 DOMPurify sanitize(BE 给的 content_html 来自 HF 用户输入,
// XSS 风险必须过滤)。afterSanitizeAttributes hook 强制所有 <a> 加 target=_blank。
// hook 是 idempotent 的(setAttribute 重复无害);PhDrawerBody 也注册一遍走同款。
if (typeof window !== "undefined") {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

const HF_COMMENT_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "a", "strong", "em", "b", "i", "u", "code", "pre",
    "blockquote", "ul", "ol", "li", "img", "span", "h1", "h2", "h3",
    "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td",
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "rel"],
};

interface Props {
  item: Item;
}

type TabKey = "raw" | "analysis";
type AbstractTab = "translated" | "original";

// HF 拆解 markdown 渲染样式 —— 轻量,只覆盖 DeepSeek pro 实际会用的元素
// (p / strong / em / ul / ol / li / code / table / a / blockquote)。
// 不引入相对路径图片 / HTML 反序列化等复杂逻辑(GH README 才需要)。
const hfMarkdownComponents: Components = {
  p: ({ children }) => <p className="my-2 leading-[1.7] text-[15px] text-neutral-800">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-neutral-900">{children}</strong>,
  em: ({ children }) => <em className="italic text-neutral-700">{children}</em>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="text-[15px] leading-[1.65] text-neutral-800">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-sky-600 hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[13px] text-neutral-800">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-[13px] text-neutral-800">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-4 border-neutral-300 bg-neutral-50/40 px-3 py-2 text-neutral-700">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-neutral-200">
      <table className="w-full text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-neutral-50">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-neutral-200 px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-neutral-500">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-neutral-200 px-3 py-1.5 text-neutral-700">{children}</td>
  ),
  h1: ({ children }) => <h4 className="mt-3 mb-1 text-[15px] font-semibold text-neutral-900">{children}</h4>,
  h2: ({ children }) => <h4 className="mt-3 mb-1 text-[15px] font-semibold text-neutral-900">{children}</h4>,
  h3: ({ children }) => <h4 className="mt-3 mb-1 text-[15px] font-semibold text-neutral-900">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-[14px] font-semibold text-neutral-900">{children}</h4>,
  hr: () => <hr className="my-3 border-neutral-200" />,
};

// 包装组件:把字符串当 markdown 渲染
function MdContent({ source }: { source: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={hfMarkdownComponents}>
      {source}
    </Markdown>
  );
}

// ─── Inline icons ─────────────────────────────────────────────────────────
function IconUpvoteTri({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 2.5l5.5 7H2.5l5.5-7z" />
    </svg>
  );
}
function IconCommentSquare({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className={className}>
      <path d="M3 4h10a1 1 0 011 1v6a1 1 0 01-1 1H8l-3 3v-3H3a1 1 0 01-1-1V5a1 1 0 011-1z" />
    </svg>
  );
}
function IconStarFilled({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 1l2.2 4.6 5 .7-3.6 3.5.9 5L8 12.3 3.5 14.8l.9-5L.8 6.3l5-.7L8 1z" />
    </svg>
  );
}
function IconUserCircle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <circle cx="8" cy="6" r="3" />
      <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    </svg>
  );
}
function IconArrowOut({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 3h8v8M13 3L5 11" />
    </svg>
  );
}
function IconCopy({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M3 11h-.5A1.5 1.5 0 011 9.5v-7A1.5 1.5 0 012.5 1h7A1.5 1.5 0 0111 2.5V3" />
    </svg>
  );
}
function IconChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[13px] font-medium text-neutral-500">{children}</div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
    >
      <IconCopy className="h-3 w-3" />
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function Kpi({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[15px] font-bold text-neutral-900 tabular-nums">
        <span className="text-neutral-500">{icon}</span>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-neutral-500">{label}</div>
    </div>
  );
}

function ExternalLinkPill({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-[13px] font-medium text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"
    >
      {label}
      <IconArrowOut className="h-3 w-3 text-neutral-400" />
    </a>
  );
}

function DimensionBlock({
  label,
  children,
  source,
}: {
  label: string;
  /** 自定义 ReactNode(experiments 用) */
  children?: React.ReactNode;
  /** 长文字符串,会用 react-markdown 渲染(单段维度用,如 problem/method) */
  source?: string;
}) {
  // BE Phase 4 prompt 改造后每段允许 200-500 字深度长文,DeepSeek pro 输出
  // 大概率含 markdown(粗体 / 列表 / 链接 / 代码 / 表格)。用 MdContent 渲染。
  return (
    <section className="border-t border-neutral-200 pt-5 first:border-t-0 first:pt-0">
      <h4 className="mb-2 text-[14px] font-semibold text-neutral-900">{label}</h4>
      <div className="text-[15px] leading-[1.7] text-neutral-800">
        {source !== undefined ? <MdContent source={source} /> : children}
      </div>
    </section>
  );
}

// 代码状态块(code_status 用):BE 返回 object {github_url/star_count/license/reproducibility/narrative}。
// 渲染:meta 行 chips(repo / stars / license / 复现难度)+ narrative 长文。
function CodeStatusBlock({ status }: { status: HfCodeStatus | undefined }) {
  if (!status) return null;
  const hasMeta =
    status.github_url || status.license || status.reproducibility !== undefined;
  if (!hasMeta && !status.narrative) return null;

  // 复现难度中文 + 配色
  const reproZh: Record<string, { label: string; cls: string }> = {
    easy: { label: "易复现", cls: "bg-emerald-100 text-emerald-700" },
    medium: { label: "中等难度", cls: "bg-amber-100 text-amber-700" },
    hard: { label: "复现困难", cls: "bg-rose-100 text-rose-700" },
  };
  const repro = status.reproducibility ? reproZh[status.reproducibility] : null;

  return (
    <section className="border-t border-neutral-200 pt-5">
      <h4 className="mb-3 text-[14px] font-semibold text-neutral-900">代码状态 Code Status</h4>

      {/* meta chip 行 */}
      {hasMeta && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {status.github_url ? (
            <a
              href={status.github_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              GitHub
              {status.star_count !== null && status.star_count !== undefined && (
                <span className="text-neutral-500">· ★ {status.star_count}</span>
              )}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-neutral-300 px-2 py-1 text-[12px] text-neutral-500">
              未开源
            </span>
          )}
          {status.license && status.license !== "unknown" && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
              {status.license}
            </span>
          )}
          {repro && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${repro.cls}`}>
              {repro.label}
            </span>
          )}
        </div>
      )}

      {/* narrative 长文 */}
      {status.narrative && (
        <div className="text-[15px] leading-[1.7] text-neutral-800">
          <MdContent source={status.narrative} />
        </div>
      )}
    </section>
  );
}

// 分条维度块(key_insight / limitations 用):BE 返回 string[],每条 200-500 字 markdown。
// 每条之间加分隔符 + 序号,避免视觉糊成一团。
function DimensionListBlock({
  label,
  sources,
}: {
  label: string;
  sources: string[];
}) {
  if (!sources || sources.length === 0) return null;
  return (
    <section className="border-t border-neutral-200 pt-5 first:border-t-0 first:pt-0">
      <h4 className="mb-3 text-[14px] font-semibold text-neutral-900">{label}</h4>
      <ol className="space-y-4">
        {sources.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[12px] font-bold text-neutral-600 tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 text-[15px] leading-[1.7] text-neutral-800">
              <MdContent source={s} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Main component ──────────────────────────────────────────────────────
export function HfPaperDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<HfPaperMetrics>(item.metrics) ?? ({} as HfPaperMetrics);

  const titleZh = extra.title_zh || item.title || "";
  const titleEn = item.title || "";
  const summaryZh = extra.summary_zh || item.content_translated || "";
  const summaryEn = item.content || "";
  // submitter / submitted_by 字段 PM v6 已从 hero 砍掉,这里保留 binding 防后续
  // 需要(评论 author_handle 比对 submitter 用)。当前未使用 → 加 void 标记避免 lint。
  void extra.submitted_by;
  const authors = extra.paper_authors || [];
  const keywords = extra.ai_keywords || [];
  const dna = extra.deep_analysis;
  const discussionComments = (extra.discussion_comments || []) as HfDiscussionComment[];
  const discussionFetchedAt = extra.discussion_fetched_at;

  // 外跳 URL — item.url 当 HF 主链接(供 hero submitter 跳),tab 内的外链精简,
  // 砍掉重复的"在 HF 打开"(用户已经在 aifeeds 看到聚合视图,不必再二跳 HF)。
  // arxiv_id 来源 priority: extra.arxiv_id(BE 可能不存)→ item.source_id(staging
  // 实际是 arxiv_id,因为 BE 用 source_id 装 arxiv_id)→ 从 item.id 剥 prefix
  const arxivId =
    extra.arxiv_id ||
    item.source_id ||
    item.id?.replace(/^hf_paper:/, "");
  const arxivUrl = `https://arxiv.org/abs/${arxivId}`;
  const githubUrl =
    extra.github_repo ||
    extra.github_url ||
    (extra.project_page && extra.project_page.includes("github.com")
      ? extra.project_page
      : null);
  const projectPage =
    extra.project_page && extra.project_page !== githubUrl ? extra.project_page : null;

  // media thumbnail
  const media = Array.isArray(item.media) ? item.media : [];
  const cover = media.find((m) => m.type === "image");

  // tab + 内部状态
  const [activeTab, setActiveTab] = useState<TabKey>("raw");
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const [abstractTab, setAbstractTab] = useState<AbstractTab>("translated");

  const visibleAuthors = authorsExpanded ? authors : authors.slice(0, 5);
  const hiddenCount = Math.max(0, authors.length - 5);

  const upvotes = metrics.upvotes;
  const numComments = metrics.num_comments;
  const githubStars = metrics.github_stars ?? extra.github_stars ?? undefined;

  return (
    <div className="text-neutral-900">
      {/* ─── Hero: thumbnail + 标题中英 + by @xxx 等 N 位提交 ─────────── */}
      <div className="border-b border-neutral-200" data-drawer-title-anchor>
        {cover && (
          <div className="aspect-[1200/630] w-full overflow-hidden bg-neutral-100">
            <img
              src={resolveAssetUrl(cover.url)}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          </div>
        )}
        <div className="p-5">
          <h2 className="text-[18px] font-bold leading-[1.35] text-neutral-900 break-words">
            {titleZh}
          </h2>
          {titleEn && titleEn !== titleZh && (
            <p className="mt-1 text-[12px] italic text-neutral-500 break-words">
              {titleEn}
            </p>
          )}

          {/* PM v6: submitter 行整段砍掉(作者列表 + 数据 KPI 已经覆盖论文出处信息) */}
        </div>
      </div>

      {/* ─── 作者列表 (PM v6: 上移到第 2 位,标题下方) ────────────────── */}
      {authors.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <SectionTitle>作者列表 · 共 {authors.length} 位</SectionTitle>
          <div className="flex flex-wrap gap-x-2 gap-y-1.5">
            {visibleAuthors.map((a, i) => (
              <span
                key={i}
                className="rounded-md bg-neutral-100 px-2 py-0.5 text-[12px] text-neutral-700"
              >
                {a.name}
              </span>
            ))}
            {!authorsExpanded && hiddenCount > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setAuthorsExpanded(true);
                }}
                className="inline-flex items-center gap-0.5 text-[12px] text-sky-600 hover:underline"
              >
                展开 +{hiddenCount} 位
                <IconChevronDown className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ─── 数据 KPI 4-col (PM v6: 第 3 位) ─────────────────────────── */}
      <div className="grid grid-cols-4 gap-2 border-b border-neutral-200 px-5 py-4 text-center">
        <Kpi
          icon={<IconUpvoteTri className="h-3.5 w-3.5" />}
          label="upvotes"
          value={upvotes !== undefined ? formatCompact(upvotes) : "—"}
        />
        <Kpi
          icon={<IconCommentSquare className="h-3.5 w-3.5" />}
          label="comments"
          value={numComments !== undefined ? formatCompact(numComments) : "—"}
        />
        <Kpi
          icon={<IconStarFilled className="h-3.5 w-3.5" />}
          label="GH stars"
          value={
            githubStars !== undefined && githubStars !== null
              ? formatCompact(githubStars)
              : "—"
          }
        />
        <Kpi
          icon={<IconUserCircle className="h-3.5 w-3.5" />}
          label="作者"
          value={authors.length > 0 ? String(authors.length) : "—"}
        />
      </div>

      {/* ─── 摘要 Abstract (PM v6: 第 4 位,下移到 KPI 之后) ─────────── */}
      {(summaryEn || summaryZh) && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <SectionTitle>摘要 Abstract</SectionTitle>
            <div className="flex items-center gap-1.5">
              <div className="flex gap-0 rounded-md border border-neutral-200 p-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAbstractTab("translated");
                  }}
                  className={
                    abstractTab === "translated"
                      ? "rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-900"
                      : "rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-700"
                  }
                >
                  译文
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAbstractTab("original");
                  }}
                  className={
                    abstractTab === "original"
                      ? "rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-900"
                      : "rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-700"
                  }
                >
                  原文
                </button>
              </div>
              <CopyButton text={abstractTab === "translated" ? summaryZh : summaryEn} />
            </div>
          </div>
          {/* MdContent 渲染 BE 翻译输出的 markdown(分段 / strong / 列表) */}
          <div className="text-[14px] leading-[1.65] text-neutral-700">
            <MdContent source={abstractTab === "translated" ? summaryZh : summaryEn} />
          </div>
        </div>
      )}

      {/* ─── 关键词 (常驻,tab 之前的最后一段) ────────────────────────── */}
      {keywords.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <SectionTitle>关键词</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {keywords.map((kw) => (
              <span
                key={kw}
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700"
              >
                #{kw}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ─── Tabs (PM v3 2.2: 下移到关键词模块下方;sticky 顶部) ─────── */}
      <div className="sticky top-0 z-10 border-b border-neutral-200 bg-white">
        <div className="flex px-5">
          <TabButton active={activeTab === "raw"} onClick={() => setActiveTab("raw")}>
            原始信息
          </TabButton>
          <TabButton active={activeTab === "analysis"} onClick={() => setActiveTab("analysis")}>
            拆解阅读
          </TabButton>
        </div>
      </div>

      {/* ─── Tab body ───────────────────────────────────────────────────── */}
      {activeTab === "raw" ? (
        <RawInfoTab
          arxivId={arxivId}
          arxivUrl={arxivUrl}
          projectPage={projectPage}
          githubUrl={githubUrl}
          discussionComments={discussionComments}
          discussionFetchedAt={discussionFetchedAt}
          discussionUrl={arxivId ? `https://huggingface.co/papers/${arxivId}#community` : null}
          commentsCount={numComments}
        />
      ) : (
        <AnalysisTab dna={dna} />
      )}
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        active
          ? "border-b-2 border-neutral-900 px-4 py-3 text-[14px] font-semibold text-neutral-900"
          : "border-b-2 border-transparent px-4 py-3 text-[14px] font-medium text-neutral-500 hover:text-neutral-700"
      }
    >
      {children}
    </button>
  );
}

// ─── Tab 1: 原始信息 (全文 → 评论 → 外链) ───────────────────────────────
interface RawInfoProps {
  arxivId: string | undefined;
  arxivUrl: string;
  projectPage: string | null;
  githubUrl: string | null;
  discussionComments: HfDiscussionComment[];
  discussionFetchedAt: string | null | undefined;
  discussionUrl: string | null;
  commentsCount: number | undefined;
}

// 正文 iframe — 嵌 arxiv.org/html LaTeXML 渲染。PM v5 方案 E。
//
// 关键点:
// - arxiv 实测无 X-Frame-Options + CORS:* → 可任意域嵌
// - LaTeXML 实时渲染需要 2-3s,加 loading skeleton 改善等待体验
// - sandbox 限制 iframe 权限,只给 scripts + popups + forms(不给 same-origin
//   防 XSS 攻击宿主页)
// - 沉浸式翻译 banner 提示用户(中文阅读体验依赖外部翻译插件)
// - 下方 chip:PDF 下载 + 新标签打开兜底(iframe 失败 / 移动端不友好)
function ArxivHtmlIframe({ arxivId }: { arxivId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const isNarrow = useIsNarrow();
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;

  return (
    <div className="space-y-2.5">
      {/* 沉浸式翻译 tips — PM v6.1: 「沉浸式翻译」纯文本不挂 link,只在「点击安装 ↓」
          唯一 anchor。↓ 暗示「下载/安装」动作。砍掉本地 .crx 兜底(referral 链接已够);
          移动端(useIsNarrow)隐藏整段,因为手机 Chrome/Safari 不支持扩展 */}
      {!isNarrow && (
        <div className="rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2 text-[12px] text-sky-900">
          推荐 <span className="font-medium">沉浸式翻译</span> — LaTeXML 全文中英对照翻译。{" "}
          <a
            href="https://immersivetranslate.com/zh-Hans/?via=roxor"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-sky-700 hover:underline"
          >
            点击安装 ↓
          </a>
        </div>
      )}

      {/* iframe 区域 — 600px 高度 + sandbox + loading skeleton。
          外层 overflow-hidden + iframe scrolling="no" 禁横向滑(PM v6 #5) */}
      <div className="relative overflow-hidden rounded-md border border-neutral-200 bg-neutral-50">
        {!loaded && !iframeError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-50 text-[13px] text-neutral-500">
            <div className="mb-2 h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-500" />
            arxiv LaTeXML 渲染中…(通常 2-3s)
          </div>
        )}
        {!iframeError ? (
          <iframe
            src={htmlUrl}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-[600px] w-full overflow-x-hidden"
            style={{ overflowX: "hidden" }}
            scrolling="auto"
            title={`arxiv ${arxivId} LaTeXML 全文`}
            onLoad={() => setLoaded(true)}
            onError={() => setIframeError(true)}
          />
        ) : (
          <div className="flex h-[200px] flex-col items-center justify-center px-4 text-center text-[13px] text-neutral-500">
            <div className="mb-1">⚠️ 嵌入加载失败</div>
            <a
              href={htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-sky-600 hover:underline"
            >
              在新标签打开 ↗
            </a>
          </div>
        )}
      </div>

      {/* 下方工具栏:PDF 下载 + 新标签打开兜底(移动端 / iframe 不友好时用) */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1 text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"
        >
          📄 下载 PDF
        </a>
        <a
          href={htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1 text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"
        >
          在新标签打开 ↗
        </a>
      </div>
    </div>
  );
}

function RawInfoTab(p: RawInfoProps) {
  return (
    <>
      {/* 正文 — PM v5 方案 E: 嵌 arxiv.org/html LaTeXML iframe(arxiv 实测无
          X-Frame-Options,允许任意域嵌)+ 上方沉浸式翻译 banner + 下方 PDF chip
          + 新标签兜底。BE 已砍 ar5iv 翻译(workflow Step 2 省 5-10 min/paper),
          不再渲染 full_text_zh markdown(字段废弃)。 */}
      {p.arxivId && (
        <div className="border-b border-neutral-200 p-5">
          <SectionTitle>正文</SectionTitle>
          <ArxivHtmlIframe arxivId={p.arxivId} />
        </div>
      )}

      {/* 评论 — discussion_fetched_at NULL 显加载中,有数据展示评论列表 */}
      <div className="border-b border-neutral-200 p-5">
        <CommentsSection
          comments={p.discussionComments}
          fetchedAt={p.discussionFetchedAt}
          discussionUrl={p.discussionUrl}
          commentsCount={p.commentsCount}
        />
      </div>

      {/* 外部链接 — PM v5: arxiv / GitHub / 项目主页 三个同款 chip 并排,
          arxiv 链接默认指向 abs 页面(用户可在 arxiv 页面点击 Download PDF)。
          砍掉之前的 PDF 子按钮 + 「打开」按钮的复合卡片样式,统一为 chip。 */}
      <div className="p-5">
        <SectionTitle>外部链接</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <ExternalLinkPill href={p.arxivUrl} label="arXiv 原文" />
          {p.githubUrl && <ExternalLinkPill href={p.githubUrl} label="GitHub 仓库" />}
          {p.projectPage && <ExternalLinkPill href={p.projectPage} label="项目主页" />}
        </div>
      </div>
    </>
  );
}

// ─── 评论 section (RawInfoTab 内) ────────────────────────────────────────
function CommentsSection({
  comments,
  fetchedAt,
  discussionUrl,
  commentsCount,
}: {
  comments: HfDiscussionComment[];
  fetchedAt: string | null | undefined;
  discussionUrl: string | null;
  commentsCount: number | undefined;
}) {
  const [tab, setTab] = useState<"translated" | "original">("translated");

  // fetched_at = null → BE 未抓 → "加载中" 占位(避免空显示)
  if (!fetchedAt) {
    return (
      <>
        <SectionTitle>评论</SectionTitle>
        <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50/40 px-3 py-5 text-center text-[13px] text-neutral-500">
          <div className="text-[18px] text-neutral-400">💬</div>
          <div className="mt-1">评论加载中…</div>
          <div className="mt-0.5 text-[11px] text-neutral-400">
            BE 抓 HF discussion 完成后自动填充
          </div>
        </div>
      </>
    );
  }

  // fetched_at 有但 comments 为空 → 该论文真的没评论(冷启动 / 新论文常见)
  if (comments.length === 0) {
    return (
      <>
        <SectionTitle>评论</SectionTitle>
        <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50/40 px-3 py-5 text-center text-[13px] text-neutral-500">
          <div>暂无评论</div>
          {discussionUrl && (
            <a
              href={discussionUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="mt-2 inline-block text-[11px] text-sky-600 hover:underline"
            >
              在 HF 发起第一条讨论 ↗
            </a>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <SectionTitle>
          评论 · {comments.length}
          {commentsCount && commentsCount > comments.length && (
            <span className="ml-1 text-neutral-400"> / 共 {commentsCount}</span>
          )}
        </SectionTitle>
        <div className="flex gap-0 rounded-md border border-neutral-200 p-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setTab("translated");
            }}
            className={
              tab === "translated"
                ? "rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-900"
                : "rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-700"
            }
          >
            译文
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setTab("original");
            }}
            className={
              tab === "original"
                ? "rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-900"
                : "rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-700"
            }
          >
            原文
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {comments.map((c, i) => (
          <CommentItem key={i} comment={c} tab={tab} />
        ))}
        {discussionUrl && commentsCount && commentsCount > comments.length && (
          <div className="pt-2 text-center">
            <a
              href={discussionUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[13px] text-sky-600 hover:underline"
            >
              在 HF 看全部 {commentsCount} 条 ↗
            </a>
          </div>
        )}
      </div>
    </>
  );
}

function CommentItem({
  comment,
  tab,
}: {
  comment: HfDiscussionComment;
  tab: "translated" | "original";
}) {
  // language=zh 的评论本身就是中文,不需要 toggle,直接显原 content。
  // 其他语言:translated tab 优先 content_zh,fallback 原文;original tab 强制原文。
  const showZh = comment.language !== "zh" && tab === "translated" && !!comment.content_zh;

  // 渲染策略:
  // - 翻译态:DeepSeek 输出纯文本(可能含轻量 markdown),用 MdContent
  // - 原文态:优先 BE 已 render 的 content_html(DOMPurify sanitize),
  //          fallback markdown(content)
  const useHtml = !showZh && !!comment.content_html;
  const sanitized = useHtml
    ? DOMPurify.sanitize(comment.content_html, HF_COMMENT_SANITIZE_CONFIG)
    : "";
  const plainBody = showZh ? (comment.content_zh as string) : comment.content;

  // 作者本人回复缩进显示(BE 推算的 is_author_reply,精确替代之前的字符串 reply_to_author)
  const indentCls = comment.is_author_reply
    ? "ml-6 border-l-2 border-amber-200 pl-3"
    : "";
  return (
    <div className={indentCls}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {comment.author_avatar_url ? (
          <img
            src={resolveAssetUrl(comment.author_avatar_url)}
            alt={comment.author_name}
            className="h-7 w-7 rounded-full bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-600">
            {(comment.author_name || "?").charAt(0)}
          </span>
        )}
        <span className="text-[13px] font-medium text-neutral-900">
          {comment.author_name}
        </span>
        {comment.author_handle && (
          <span className="text-[11px] text-neutral-500">@{comment.author_handle}</span>
        )}
        {/* 作者本人(论文 submitter)回复 badge —— amber 突出 */}
        {comment.is_author_reply && (
          <span className="rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-semibold text-amber-800">
            作者
          </span>
        )}
        {comment.is_hf_admin && (
          <span className="rounded-full bg-rose-100 px-1.5 py-0 text-[10px] font-semibold text-rose-800">
            HF 官方
          </span>
        )}
        {comment.is_pro && !comment.is_hf_admin && (
          <span className="rounded-full bg-neutral-100 px-1.5 py-0 text-[10px] font-medium text-neutral-700">
            PRO
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-neutral-400">
          {timeAgo(comment.posted_at)}
          {comment.edited && (
            <span className="text-neutral-400" title="此评论被编辑过">
              · 已编辑
            </span>
          )}
        </span>
      </div>

      {/* 评论正文 — content_html 优先(BE rendered + DOMPurify),fallback markdown */}
      {useHtml ? (
        <div
          className="ml-9 hf-comment-html text-[14px] leading-[1.6] text-neutral-800"
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      ) : (
        <div className="ml-9 text-[14px] leading-[1.6] text-neutral-800">
          <MdContent source={plainBody} />
        </div>
      )}

      {/* Reactions 行 — 多 emoji 反应,👍 like_count 兜底优先显示 */}
      {(comment.reactions?.length > 0 || comment.like_count > 0) && (
        <div className="ml-9 mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
          {comment.reactions && comment.reactions.length > 0 ? (
            comment.reactions.map((r, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-neutral-600"
              >
                <span className="text-[12px]">{r.emoji}</span>
                <span className="tabular-nums text-[11px]">{r.count}</span>
              </span>
            ))
          ) : (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-neutral-600">
              <span>👍</span>
              <span className="tabular-nums text-[11px]">{comment.like_count}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tab 2: 拆解阅读 (TL;DR + 7 维度) ────────────────────────────────────
function AnalysisTab({ dna }: { dna: ItemExtra["deep_analysis"] }) {
  if (!dna) {
    return (
      <div className="p-5">
        <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50/40 px-3 py-8 text-center text-[13px] text-neutral-500">
          <div className="text-[18px] text-neutral-400">⏳</div>
          <div className="mt-1">深度拆解生成中…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5">
      {/* TL;DR — 轻量 callout,markdown 渲染(BE pro reasoning 输出可能含 **粗体** / 列表) */}
      {dna.tldr && (
        <div className="mb-6 rounded-md border-l-4 border-neutral-300 bg-neutral-50/60 px-4 py-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            TL;DR
          </div>
          <div className="text-[15px] leading-[1.55] text-neutral-800">
            <MdContent source={dna.tldr} />
          </div>
        </div>
      )}

      {/* 7 个维度 — 大段长文。当前 mock 数据每段较短(BE Phase 4 改 prompt 后输出 200-500 字深度内容) */}
      <div className="space-y-6">
        <DimensionBlock label="问题 Problem" source={dna.problem} />
        <DimensionListBlock label="核心创新 Key Insight" sources={dna.key_insight} />
        <DimensionBlock label="方法 Method" source={dna.method} />

        {/* 实验 — 结构化 datasets / metrics / compute */}
        <section className="border-t border-neutral-200 pt-5">
          <h4 className="mb-2 text-[14px] font-semibold text-neutral-900">实验 Experiments</h4>
          {dna.experiments && (
            <div className="space-y-3">
              {dna.experiments.datasets?.length > 0 && (
                <div>
                  <div className="mb-1 text-[12px] text-neutral-500">数据集</div>
                  <div className="flex flex-wrap gap-1.5">
                    {dna.experiments.datasets.map((d) => (
                      <span
                        key={d}
                        className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700"
                      >
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {dna.experiments.key_metrics?.length > 0 && (
                <div className="overflow-hidden rounded-md border border-neutral-200">
                  <table className="w-full text-[13px]">
                    <thead className="bg-neutral-50">
                      <tr className="text-left text-[11px] uppercase tracking-wide text-neutral-500">
                        <th className="px-3 py-1.5 font-medium">指标</th>
                        <th className="px-3 py-1.5 text-right font-medium">数值</th>
                        <th className="px-3 py-1.5 text-right font-medium">vs baseline</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dna.experiments.key_metrics.map((m, i) => (
                        <tr key={i} className="border-t border-neutral-200">
                          <td className="px-3 py-1.5 text-neutral-700">{m.name}</td>
                          <td className="px-3 py-1.5 text-right font-semibold text-neutral-900 tabular-nums">
                            {m.value}
                          </td>
                          <td className="px-3 py-1.5 text-right text-neutral-600 tabular-nums">
                            {m.vs_baseline}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {dna.experiments.compute && (
                <div className="text-[12px] text-neutral-500">
                  算力：
                  <span className="font-mono text-neutral-600">{dna.experiments.compute}</span>
                </div>
              )}
              {/* narrative 实验叙事(BE pro reasoning 输出,2026-05-18 起返回)
                  比 datasets/metrics 信息密度更大,放最后用 MdContent 完整渲 */}
              {dna.experiments.narrative && (
                <div className="rounded-md border border-neutral-200 bg-neutral-50/40 p-3 text-[14px] leading-[1.7] text-neutral-700">
                  <MdContent source={dna.experiments.narrative} />
                </div>
              )}
            </div>
          )}
        </section>

        <DimensionBlock label="工业影响 Industry Impact" source={dna.industry_impact} />
        <CodeStatusBlock status={dna.code_status} />
        <DimensionListBlock label="局限 Limitations" sources={dna.limitations} />
      </div>

    </div>
  );
}

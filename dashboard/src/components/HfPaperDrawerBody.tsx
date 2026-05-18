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
  HfDiscussionComment,
  HfPaperMetrics,
  Item,
  ItemExtra,
} from "../types";
import { formatCompact, parseJsonField, timeAgo } from "../lib/utils";

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
function IconDownload({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 2v8M4 8l4 4 4-4M3 14h10" />
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
  /** 长文字符串,会用 react-markdown 渲染(7 维度文本字段用) */
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

// ─── Main component ──────────────────────────────────────────────────────
export function HfPaperDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<HfPaperMetrics>(item.metrics) ?? ({} as HfPaperMetrics);

  const titleZh = extra.title_zh || item.title || "";
  const titleEn = item.title || "";
  const summaryZh = extra.summary_zh || item.content_translated || "";
  const summaryEn = item.content || "";
  const submitter = extra.submitted_by;
  const authors = extra.paper_authors || [];
  const keywords = extra.ai_keywords || [];
  const dna = extra.deep_analysis;
  const fullTextZh = extra.full_text_zh;
  const discussionComments = (extra.discussion_comments || []) as HfDiscussionComment[];
  const discussionFetchedAt = extra.discussion_fetched_at;

  // 外跳 URL — item.url 当 HF 主链接(供 hero submitter 跳),tab 内的外链精简,
  // 砍掉重复的"在 HF 打开"(用户已经在 aifeeds 看到聚合视图,不必再二跳 HF)。
  const arxivUrl = `https://arxiv.org/abs/${extra.arxiv_id}`;
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
              src={cover.url}
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

          {/* Submitter 行 — PM v3: 删 fullname / 删"到 HF Daily"文案 / 加 "等 N 位提交" */}
          {submitter && (
            <div className="mt-3 flex items-center gap-2 text-[13px] text-neutral-500">
              {submitter.avatar_url ? (
                <img
                  src={submitter.avatar_url}
                  alt={submitter.user}
                  className="h-6 w-6 rounded-full bg-neutral-200 object-cover"
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                />
              ) : (
                <span className="h-6 w-6 rounded-full bg-neutral-200" />
              )}
              <span>
                由{" "}
                <a
                  href={`https://huggingface.co/${submitter.user}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-neutral-700 hover:text-sky-600 hover:underline"
                >
                  @{submitter.user}
                </a>
                {authors.length > 1 && (
                  <span> 等 {authors.length} 位</span>
                )}
                {" 提交"}
                {submitter.is_pro && (
                  <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                    PRO
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ─── 摘要 Abstract (PM v3 2.3: 上移到 by 张三下方,常驻不切 tab) ── */}
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
          <p className="whitespace-pre-wrap text-[14px] leading-[1.65] text-neutral-700">
            {abstractTab === "translated" ? summaryZh : summaryEn}
          </p>
        </div>
      )}

      {/* ─── 数据 KPI 4-col (常驻) ───────────────────────────────────── */}
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

      {/* ─── 作者列表 (常驻,折叠) ─────────────────────────────────────── */}
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
          ar5ivUrl={extra.ar5iv_html_url}
          fullTextZh={fullTextZh}
          arxivPdfUrl={extra.arxiv_pdf_url}
          arxivUrl={arxivUrl}
          projectPage={projectPage}
          githubUrl={githubUrl}
          discussionComments={discussionComments}
          discussionFetchedAt={discussionFetchedAt}
          discussionUrl={
            extra.arxiv_id
              ? `https://huggingface.co/papers/${extra.arxiv_id}#community`
              : null
          }
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
  ar5ivUrl: string | undefined;
  fullTextZh: string | null | undefined;
  arxivPdfUrl: string | undefined;
  arxivUrl: string;
  projectPage: string | null;
  githubUrl: string | null;
  discussionComments: HfDiscussionComment[];
  discussionFetchedAt: string | null | undefined;
  discussionUrl: string | null;
  commentsCount: number | undefined;
}

function RawInfoTab(p: RawInfoProps) {
  return (
    <>
      {/* 全文翻译 (Phase 2 ar5iv,placeholder) */}
      <div className="border-b border-neutral-200 p-5">
        <div className="mb-2 flex items-center justify-between">
          <SectionTitle>全文翻译</SectionTitle>
          {p.ar5ivUrl && (
            <a
              href={p.ar5ivUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-sky-600 hover:underline"
            >
              在 ar5iv 看 HTML 原文 ↗
            </a>
          )}
        </div>
        {p.fullTextZh ? (
          <p className="whitespace-pre-wrap text-[14px] leading-[1.7] text-neutral-700">
            {p.fullTextZh}
          </p>
        ) : (
          <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50/40 px-3 py-5 text-center text-[13px] text-neutral-500">
            <div className="text-[18px] text-neutral-400">⏳</div>
            <div className="mt-1">全文翻译正在抓取中…</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">
              ar5iv 段落级翻译由 Phase 2 实现,预计上线后自动填充
            </div>
          </div>
        )}
      </div>

      {/* 评论 — discussion_fetched_at NULL 显加载中,有数据展示评论列表 */}
      <div className="border-b border-neutral-200 p-5">
        <CommentsSection
          comments={p.discussionComments}
          fetchedAt={p.discussionFetchedAt}
          discussionUrl={p.discussionUrl}
          commentsCount={p.commentsCount}
        />
      </div>

      {/* 外部链接 — 精简(arxiv 含 PDF 子按钮 + GitHub + 项目主页;砍 HF) */}
      <div className="p-5">
        <SectionTitle>外部链接</SectionTitle>
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-neutral-900">arXiv 原文</div>
              <div className="text-[11px] text-neutral-500 truncate">{p.arxivUrl}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {p.arxivPdfUrl && (
                <a
                  href={p.arxivPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                  title="下载 PDF"
                >
                  <IconDownload className="h-3 w-3" />
                  PDF
                </a>
              )}
              <a
                href={p.arxivUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
              >
                <IconArrowOut className="h-3 w-3" />
                打开
              </a>
            </div>
          </div>
          {(p.githubUrl || p.projectPage) && (
            <div className="flex flex-wrap gap-2">
              {p.githubUrl && <ExternalLinkPill href={p.githubUrl} label="GitHub 仓库" />}
              {p.projectPage && <ExternalLinkPill href={p.projectPage} label="项目主页" />}
            </div>
          )}
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
            src={comment.author_avatar_url}
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
        <DimensionBlock label="核心创新 Key Insight" source={dna.key_insight} />
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
            </div>
          )}
        </section>

        <DimensionBlock label="工业影响 Industry Impact" source={dna.industry_impact} />
        <DimensionBlock label="代码状态 Code Status" source={dna.code_status} />
        <DimensionBlock label="局限 Limitations" source={dna.limitations} />
      </div>

      {/* 占位提醒(mockup 阶段) — PM v2 要求拆解长度有深度,需 BE 改 prompt */}
      <div className="mt-8 rounded-md border border-dashed border-neutral-300 bg-amber-50/40 px-3 py-3 text-[11px] text-neutral-500">
        <strong className="text-neutral-700">mockup 注:</strong> 当前每段为示例文本(50-150 字)。
        PM 反馈:实际希望每段是 200-500 字深度长文(可能上 DeepSeek pro
        research mode / 多 subagent 分维度生成)。BE Phase 4 改 prompt + 输出
        schema 后此处自动承载长文(已预留 leading-[1.7] 大行距 + whitespace-pre-wrap)。
      </div>
    </div>
  );
}

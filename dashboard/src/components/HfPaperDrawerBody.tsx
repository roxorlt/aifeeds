// HuggingFace Daily Paper drawer body — Phase 0 mockup
//
// 9 sections per docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md §6.6：
//   ① Hero        - thumbnail + title 中英 + ai_summary_zh + novelty + submitter
//   ② TL;DR       - deep_analysis.tldr，黑底白字强调
//   ③ 8 维度拆解   - problem / key_insight / method / experiments / industry_impact / code_status / limitations
//   ④ HF 元信息    - KPI 4-col grid（upvotes / comments / stars / submitter pro）
//   ⑤ 作者列表     - 折叠区，>5 时展开看全
//   ⑥ AI Keywords  - chip 行
//   ⑦ 全文翻译     - mockup 阶段占位「全文翻译加载中…（Phase 2 上线）」
//   ⑧ 原文 Abstract - 英文 + 复制按钮 + 跳 arxiv
//   ⑨ 外跳行       - HF / arXiv / GitHub（若有）三个按钮
//
// 视觉对齐 PhDrawerBody：neutral 调色 / border-b 分隔 / 无 shadow /
// 标题 text-[13px] font-medium text-neutral-500 / 正文 text-[15px] leading-[1.55]

import { useState } from "react";
import type {
  HfPaperMetrics,
  Item,
  ItemExtra,
} from "../types";
import { formatCompact, parseJsonField } from "../lib/utils";
import { NoveltyStars } from "./HfPaperCard";

interface Props {
  item: Item;
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
function DimensionBlock({
  index,
  label,
  children,
}: {
  index: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-[11px] font-bold text-white tabular-nums">
          {index}
        </span>
        <span className="text-[13px] font-medium text-neutral-500">{label}</span>
      </div>
      <div className="ml-7 text-[15px] leading-[1.55] text-neutral-800">{children}</div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[15px] font-bold text-neutral-900 tabular-nums">
        <span className="text-neutral-500">{icon}</span>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-neutral-500">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] text-neutral-400">{hint}</div>}
    </div>
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

function ExternalLinkPill({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
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

// ─── Main component ──────────────────────────────────────────────────────
export function HfPaperDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<HfPaperMetrics>(item.metrics) ?? ({} as HfPaperMetrics);

  const titleZh = extra.title_zh || item.title || "";
  const titleEn = item.title || "";
  const summaryZh = extra.summary_zh || item.content_translated || "";
  const summaryEn = item.content || "";
  const aiSummaryZh = extra.ai_summary_zh || "";
  const novelty = extra.deep_analysis?.novelty_rating ?? 0;
  const submitter = extra.submitted_by;
  const authors = extra.paper_authors || [];
  const keywords = extra.ai_keywords || [];
  const dna = extra.deep_analysis;
  const fullTextZh = extra.full_text_zh;

  // 外跳 URL — item.url 当 HF 主链接，arxiv 链接独立从 arxiv_id 构造
  const hfUrl = item.url || `https://huggingface.co/papers/${extra.arxiv_id}`;
  const arxivUrl = `https://arxiv.org/abs/${extra.arxiv_id}`;
  // github_repo 优先；BE 字段命名待定（github_repo / github_url 二选一），FE 兼容
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

  // Authors 折叠区
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const visibleAuthors = authorsExpanded ? authors : authors.slice(0, 5);
  const hiddenCount = Math.max(0, authors.length - 5);

  // Abstract 译/原 tab
  const [abstractTab, setAbstractTab] = useState<"translated" | "original">("translated");

  const upvotes = metrics.upvotes;
  const numComments = metrics.num_comments;
  const githubStars = metrics.github_stars ?? extra.github_stars ?? undefined;

  return (
    <div className="text-neutral-900">
      {/* ① Hero — 大图 cover + 标题中英 + ai_summary 副标 + 提交人 + ★ novelty */}
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
          {/* 标题中译为主，英文原标题灰色小字辅助。novelty 跟标题挤同行右上 */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-bold leading-[1.35] text-neutral-900 break-words">
                {titleZh}
              </h2>
              {titleEn && titleEn !== titleZh && (
                <p className="mt-1 text-[12px] italic text-neutral-500 break-words">
                  {titleEn}
                </p>
              )}
            </div>
            {novelty > 0 && (
              <div className="shrink-0 text-right">
                <NoveltyStars rating={novelty} size="lg" />
                <div className="mt-0.5 text-[10px] text-neutral-400">
                  AI 新颖度评分
                </div>
              </div>
            )}
          </div>

          {/* ai_summary_zh 作为 hero 副标 */}
          {aiSummaryZh && (
            <p className="mt-2.5 text-[14px] leading-[1.55] text-neutral-700">
              {aiSummaryZh}
            </p>
          )}

          {/* Submitter 行 */}
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
                {submitter.fullname && submitter.fullname !== submitter.user && (
                  <span className="text-neutral-400"> ({submitter.fullname})</span>
                )}
                {" "}提交到 HF Daily
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

      {/* ② TL;DR — 反白强调块（黑底白字）+ 大字号 */}
      {dna?.tldr && (
        <div className="border-b border-neutral-200 bg-neutral-900 px-5 py-5 text-white">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            TL;DR
          </div>
          <p className="text-[16px] leading-[1.55] text-neutral-50">{dna.tldr}</p>
        </div>
      )}

      {/* ③ 8 维度拆解 — 标题统一编号 + neutral 标签 + 左缩进正文 */}
      {dna && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="text-[13px] font-medium text-neutral-500">论文 8 维度拆解</span>
            <span className="rounded-full bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
              AI 生成 · 由 DeepSeek 输出
            </span>
          </div>
          <div className="space-y-4">
            <DimensionBlock index={1} label="问题 Problem">
              {dna.problem}
            </DimensionBlock>
            <DimensionBlock index={2} label="核心创新 Key Insight">
              {dna.key_insight}
            </DimensionBlock>
            <DimensionBlock index={3} label="方法 Method">
              {dna.method}
            </DimensionBlock>
            <DimensionBlock index={4} label="实验 Experiments">
              {dna.experiments && (
                <div className="space-y-3">
                  {/* datasets chips */}
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
                  {/* key_metrics 3 列 grid（name / value / vs_baseline） */}
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
                  {/* compute 单行 mono */}
                  {dna.experiments.compute && (
                    <div className="text-[12px] text-neutral-500">
                      算力：
                      <span className="font-mono text-neutral-600">
                        {dna.experiments.compute}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </DimensionBlock>
            <DimensionBlock index={5} label="工业影响 Industry Impact">
              {dna.industry_impact}
            </DimensionBlock>
            <DimensionBlock index={6} label="代码状态 Code Status">
              {dna.code_status}
            </DimensionBlock>
            <DimensionBlock index={7} label="局限 Limitations">
              {dna.limitations}
            </DimensionBlock>
          </div>
        </div>
      )}

      {/* ④ HF 元信息 KPI 行 */}
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

      {/* ⑤ 作者列表 — 折叠区，>5 时展开 */}
      {authors.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-2.5 text-[13px] font-medium text-neutral-500">
            作者列表 · 共 {authors.length} 位
          </div>
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

      {/* ⑥ AI Keywords — 全部展示 */}
      {keywords.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-2 text-[13px] font-medium text-neutral-500">
            AI 关键词 · 由 HF 自动生成
          </div>
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

      {/* ⑦ 全文翻译 — mockup 阶段占位（Phase 2 BE 实现 ar5iv 抓 + 段落翻译） */}
      <div className="border-b border-neutral-200 p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-neutral-500">全文翻译</span>
          {extra.ar5iv_html_url && (
            <a
              href={extra.ar5iv_html_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-sky-600 hover:underline"
            >
              在 ar5iv 看 HTML 原文 ↗
            </a>
          )}
        </div>
        {fullTextZh ? (
          // 真实数据时 markdown 渲染（mockup 阶段不接 markdown lib，留空给 Phase 2）
          <p className="whitespace-pre-wrap text-[14px] leading-[1.7] text-neutral-700">
            {fullTextZh}
          </p>
        ) : (
          <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50/40 px-3 py-6 text-center text-[13px] text-neutral-500">
            <div className="text-[18px] text-neutral-400">⏳</div>
            <div className="mt-1">全文翻译正在抓取中…</div>
            <div className="mt-0.5 text-[11px] text-neutral-400">
              ar5iv 段落级翻译由 Phase 2 实现，预计上线后自动填充
            </div>
          </div>
        )}
      </div>

      {/* ⑧ 原文 Abstract — 双 tab 译/原 + 复制按钮 */}
      {(summaryEn || summaryZh) && (
        <div className="border-b border-neutral-200 p-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-neutral-500">原文 Abstract</span>
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

      {/* ⑨ 外跳行 — HF / arXiv / GitHub */}
      <div className="p-5">
        <div className="mb-2 text-[13px] font-medium text-neutral-500">外部链接</div>
        <div className="flex flex-wrap gap-2">
          <ExternalLinkPill href={hfUrl} label="在 HF 打开" />
          <ExternalLinkPill href={arxivUrl} label="在 arXiv 打开" />
          {extra.arxiv_pdf_url && (
            <ExternalLinkPill href={extra.arxiv_pdf_url} label="下载 PDF" />
          )}
          {githubUrl && <ExternalLinkPill href={githubUrl} label="在 GitHub 打开" />}
          {projectPage && (
            <ExternalLinkPill href={projectPage} label="项目主页" />
          )}
        </div>
      </div>
    </div>
  );
}

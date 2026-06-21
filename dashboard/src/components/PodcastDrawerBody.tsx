// Podcast (官方新闻 / AI 播客) drawer body — 收听路径，对照设计文档 §10.3 +
// mockup docs/plans/_mockups/2026-06-09-feeds-drawer-podcast.html。
// 全站首个 <audio> 形态。
//
// 区段顺序:
//   1. 节目封面 + 节目名 + 单集标题（外文源加英文原标题）
//   2. meta 行：时长 · 时间 · (A 档) 有文字稿 chip（无 metrics 行）
//   3. 音频播放器置顶（MVP 原生 <audio controls>，src = 原始 enclosure 直链，
//      绝不走 /r/：R2 反代无 Range → seek 失效 + 串流过 1c1g 香港中转 OOM）
//   4. ELI25 摘要（概览）
//   5. shownotes / 章节（带时间戳；hfMarkdownComponents 轻量版渲染 shownotes）
//   6. (A 档) transcript 折叠区 + 译/原 toggle；B/C 档无此区
//
// 「在原平台收听」外链不在本组件 —— 由 TweetDrawer 的 footer（externalLinkLabel
// 分支，fe-integration 接线）统一渲染，与其它源一致；音频播放失败也靠它兜底。
//
// AudioPlayer 由 fe-cards 写，但为避免并行写竞态（其 props 签名未在契约固定），
// 此处内联等价的原生 <audio controls>，零外部依赖、零 emoji。

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Item, ItemExtra } from "../types";
import { fetchItem, addDubWishlist, getDubWishlistState } from "../api";
import { cn, parseJsonField, timeAgo } from "../lib/utils";
import { resolveAssetUrl } from "../lib/asset";
import { BrandPodcast, IconClock, IconMic, IconUser } from "./icons";

// shownotes 轻量 markdown 渲染（hfMarkdownComponents 风，只覆盖 RSS shownotes
// 常见元素；不引入相对路径图片 / HTML 反序列化）。13px 对齐抽屉正文层级。
const shownotesComponents: Components = {
  p: ({ children }) => <p className="my-2 text-[13px] leading-[1.7] text-neutral-700">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-neutral-900">{children}</strong>,
  em: ({ children }) => <em className="italic text-neutral-700">{children}</em>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-neutral-700">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-neutral-700">{children}</ol>,
  li: ({ children }) => <li className="text-[13px] leading-[1.6] text-neutral-700">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-sky-600 hover:underline break-all"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800">{children}</code>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-neutral-300 pl-3 italic text-neutral-600">{children}</blockquote>
  ),
  h1: ({ children }) => <h4 className="mt-3 mb-1 text-[14px] font-semibold text-neutral-900">{children}</h4>,
  h2: ({ children }) => <h4 className="mt-3 mb-1 text-[14px] font-semibold text-neutral-900">{children}</h4>,
  h3: ({ children }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold text-neutral-900">{children}</h4>,
  hr: () => <hr className="my-3 border-neutral-200" />,
};

// 秒 → "H:MM:SS" / "M:SS"（单集时长，meta 行用；0 / 空返回 ""）
function formatDuration(sec: number | undefined | null): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// 秒 → 时间戳（章节用，0 显示 "00:00"）
function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// 译/原 toggle —— lucide languages 图标（icons.tsx 暂无，本地内联；零 emoji）
function IconTranslate({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

// 实心三角 play（复用 PhCard 同款 path，禁 ▶ emoji）
function IconPlay({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

// lucide file-text（有文字稿 chip / transcript 区）
function IconFileText({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

// lucide list（章节 / shownotes 头）
function IconList({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="8" x2="21" y1="6" y2="6" />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6" y2="6" />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </svg>
  );
}

// chevron-down（折叠区）
function IconChevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// lucide check（假门「已加入」确认态）
function IconCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// 译/原 pill 段控（对齐 mockup：rounded-full border，active = neutral-900 黑底）
function LangToggle({
  value,
  onChange,
}: {
  value: "zh" | "orig";
  onChange: (v: "zh" | "orig") => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-neutral-200 p-0.5 text-[12px]">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChange("zh");
        }}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-1",
          value === "zh" ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50",
        )}
      >
        <IconTranslate className="h-3.5 w-3.5" />
        译文
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChange("orig");
        }}
        className={cn(
          "rounded-full px-2.5 py-1",
          value === "orig" ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50",
        )}
      >
        原文
      </button>
    </div>
  );
}

interface Props {
  item: Item;
}

export function PodcastDrawerBody({ item }: Props) {
  // 空格键控播(2026-06-12 验收反馈 #2):抽屉打开时按空格 = play/pause,阻止
  // 默认滚动穿透到底层 feed。target 是表单控件/audio 自身/按钮时让原生行为接管
  // (audio 聚焦时原生空格已是 play/pause,避免双触发)。
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button" || tag === "audio" || t?.isContentEditable) return;
      const a = audioRef.current;
      if (!a) return;
      e.preventDefault();
      if (a.paused) void a.play().catch(() => {});
      else a.pause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 列表已剥 shownotes/transcript 重字段且 refresh 端点不覆盖 podcast,
  // 抽屉 mount 自拉完整 item 补 shownotes_zh / transcript_text_zh(同 BlogDrawerBody)。
  const [fullItem, setFullItem] = useState<Item | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFullItem(null);
    fetchItem(item.id)
      .then((resp) => {
        if (!cancelled && resp.item) setFullItem(resp.item);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.id]);

  // 假门「翻译成中文音频」:点击只记需求(addDubWishlist),不真做配音。
  // 挂载查当前设备是否已点过,刷新后回显「已加入」(切换不同单集时先重置)。
  const [dubAdded, setDubAdded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDubAdded(false);
    getDubWishlistState(item.id).then((w) => {
      if (!cancelled && w) setDubAdded(true);
    });
    return () => { cancelled = true; };
  }, [item.id]);

  const view = fullItem ?? item;
  const extra = parseJsonField<ItemExtra>(view.extra) ?? ({} as ItemExtra);

  const pub = extra.publisher;
  const showName = extra.show_name || pub?.name || extra.source_company || item.author || "";
  const coverSrc = extra.cover_image ? resolveAssetUrl(extra.cover_image) : "";

  // 标题：中译为主，外文源补英文原标题
  const titleZh = extra.title_zh || item.title || "";
  const titleOriginal = item.title || "";
  const isForeign = (item.lang || "") !== "zh";
  const showOriginalTitle = isForeign && !!titleOriginal && titleOriginal !== titleZh;

  // 音频:迁 R2 后是 /r/podcast/<sha> 路径(resolveAssetUrl 拼 API base,经香港中转,
  // /r/ 已支持 Range seek);存量未迁/超大兜底仍是原始 enclosure 直链(http 透传)。
  const audioUrl = extra.audio_url ? resolveAssetUrl(extra.audio_url) : "";

  const durationLabel = formatDuration(extra.duration_sec);
  const publishedAt = item.published_at || item.scraped_at;

  // 主持/嘉宾(podcast:person 结构化 + LLM 抽取)。guests 对 hosts 去重(显示层兜底)。
  const hostsArr = Array.isArray(extra.hosts)
    ? (extra.hosts as unknown[]).filter((h): h is string => typeof h === "string" && !!h.trim())
    : [];
  const hostLower = new Set(hostsArr.map((h) => h.toLowerCase()));
  const guestsArr = Array.isArray(extra.guests)
    ? (extra.guests as unknown[]).filter(
        (g): g is string => typeof g === "string" && !!g.trim() && !hostLower.has(g.toLowerCase()),
      )
    : [];

  // 本期话题脉络(奥卡姆剃刀时间轴):每节点 = 时间点 · 主题 · 该时段核心观点 · 说话人。
  // 单节点不成"轴"(烂源 VTT 偶发产物),≥2 才渲染。
  const timelineRaw = Array.isArray(extra.timeline) ? extra.timeline : [];
  const timeline = timelineRaw.length >= 2 ? timelineRaw : [];

  // 概览 = 纯 LLM 生成的 ELI25 摘要(deepseek)。不再兜底 shownotes —— 否则无
  // ai_summary 时「概览」会和「节目简介」展示同一段原文(2026-06-12 用户反馈:二者
  // 关系混淆)。无 LLM 摘要时这块直接省略,节目简介那块照常出抓取的原文。
  const summary = extra.ai_summary_zh || extra.ai_summary || "";

  // shownotes：外文源优先中译，中文源用原文
  const shownotes = isForeign
    ? extra.shownotes_zh || extra.shownotes || ""
    : extra.shownotes || "";
  const chapters = extra.chapters || [];

  // transcript（A 档才有）：译/原
  const transcriptRaw = extra.transcript_text || "";
  const transcriptZh = extra.transcript_text_zh || "";
  const hasTranscript = !!(transcriptRaw || transcriptZh);
  const [tTab, setTTab] = useState<"zh" | "orig">(
    isForeign && transcriptZh ? "zh" : "orig",
  );
  // 同 BlogDrawerBody:首渲染时列表瘦 item 没有 transcript_text_zh(被剥),
  // tTab 定格 "orig";full-fetch 回填后自动切译文(用户手动切过则尊重)。
  const userSwitchedTTab = useRef(false);
  useEffect(() => {
    if (!userSwitchedTTab.current && isForeign && transcriptZh) setTTab("zh");
  }, [isForeign, transcriptZh]);
  const [tOpen, setTOpen] = useState(false);
  const transcriptToShow = tTab === "zh" ? transcriptZh || transcriptRaw : transcriptRaw;
  // 文字稿规模提示（约 N 字，按默认展示文本估，round 到百位）
  const tLen = (transcriptZh || transcriptRaw).length;
  const tLenLabel = tLen > 0
    ? `${isForeign ? "英译中 · " : ""}约 ${Math.max(100, Math.round(tLen / 100) * 100)} 字`
    : "";

  return (
    <div className="text-neutral-900">
      <div className="space-y-5 px-5 py-5">
        {/* ① 节目封面 + 节目名 + 单集标题 */}
        <div className="flex gap-3.5" data-drawer-title-anchor>
          <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100">
            {coverSrc && (
              <img
                src={coverSrc}
                alt={showName}
                className="h-full w-full object-cover"
                loading="eager"
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              />
            )}
            {audioUrl && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white">
                  <IconPlay className="ml-0.5 h-5 w-5" />
                </span>
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[13px] text-neutral-500">
              <BrandPodcast className="h-4 w-4 shrink-0 text-neutral-400" />
              <span className="truncate font-medium text-neutral-700">{showName}</span>
            </div>
            <h2 className="mt-1 text-[18px] font-bold leading-snug text-neutral-900 break-words">
              {titleZh}
            </h2>
            {showOriginalTitle && (
              <p className="mt-1 text-[13px] leading-snug text-neutral-400 break-words">
                {titleOriginal}
              </p>
            )}
          </div>
        </div>

        {/* ② meta：时长 · 时间（无互动数行；有文字稿标签已删——无效信息 2026-06-12 #1） */}
        <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-500">
          {durationLabel && (
            <span className="inline-flex items-center gap-1">
              <IconClock className="h-3.5 w-3.5" />
              <span className="tabular-nums">{durationLabel}</span>
            </span>
          )}
          {durationLabel && publishedAt && <span className="text-neutral-400">·</span>}
          {publishedAt && <span>{timeAgo(publishedAt)}</span>}
        </div>

        {/* ②.5 主持/嘉宾(有结构化或 LLM 抽取的才显)各带图标提升识别度(2026-06-12 #3) */}
        {(hostsArr.length > 0 || guestsArr.length > 0) && (
          <div className="flex flex-col gap-1.5">
            {hostsArr.length > 0 && (
              <div className="flex items-start gap-2 text-[13px]">
                <IconMic className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
                <span className="shrink-0 font-medium text-neutral-500">主持</span>
                <span className="break-words text-neutral-700">{hostsArr.join("、")}</span>
              </div>
            )}
            {guestsArr.length > 0 && (
              <div className="flex items-start gap-2 text-[13px]">
                <IconUser className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
                <span className="shrink-0 font-medium text-neutral-500">嘉宾</span>
                <span className="break-words text-neutral-700">{guestsArr.join("、")}</span>
              </div>
            )}
          </div>
        )}

        {/* ③ 音频播放器置顶 —— 原生 <audio controls>。空格键全抽屉控播(2026-06-12
            验收反馈:PC 上空格穿透滚动底层 feed,预期 play/pause)。 */}
        {audioUrl ? (
          <div>
            <div className="mb-1.5 text-[13px] font-semibold text-neutral-700">收听</div>
            {/* src 直接挂 <audio>（§10.3）：podcast enclosure 的 mime 常不可靠
                （application/octet-stream 等会让 <source type> 被浏览器跳过），
                直挂 src 让浏览器自行尝试，最稳。preload=none(D4):点播放才加载,
                时长 UI 用 extra.duration_sec。 */}
            <audio
              ref={audioRef}
              controls
              preload="none"
              src={audioUrl}
              className="w-full"
            >
              您的浏览器不支持音频播放。
            </audio>
            {/* 假门:翻译成中文音频(painted door)。点击只记需求强度,不真做配音。
                点击后就地变「已加入愿望清单」绿色确认态,刷新后保持。 */}
            <div className="mt-2.5">
              {dubAdded ? (
                <div className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700">
                  <IconCheck className="h-4 w-4 shrink-0" />
                  已加入愿望清单
                </div>
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDubAdded(true); // 乐观更新;信号失败也静默,不打扰用户
                    void addDubWishlist(item.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-md border border-neutral-300 px-3 py-2 text-left text-[13px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
                >
                  <IconTranslate className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="flex flex-col leading-tight">
                    <span>翻译成中文音频</span>
                    <span className="text-[11px] font-normal text-neutral-400">AI 配音 · 区分主持与嘉宾</span>
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : (
          /* 该 feed 混发图文 newsletter(Latent Space/Last Week in AI 的 Substack),
             此类 entry 无 enclosure 音频,占位说明而非空缺(2026-06-12 验收反馈 #4)。 */
          <p className="text-[13px] text-neutral-400">本期为图文内容,无音频;全文见下方或原文链接。</p>
        )}

        {/* ④ ELI25 摘要（标 "概览"，避免向终端用户暴露 ELI25 内部代号） */}
        {summary && (
          <div>
            <div className="mb-1.5 text-[13px] font-semibold text-neutral-700">概览</div>
            <div className="rounded-xl bg-neutral-50 px-4 py-3 text-[15px] leading-relaxed text-neutral-700">
              {summary}
            </div>
          </div>
        )}

        {/* ⑤ 节目简介 / 章节（抓取的 RSS 原文，发布方所写；外文优先中译）。有
            chapters 出章节列表，否则退化为 shownotes markdown 轻量渲染。
            排在「话题脉络」之前——官方描述先于 LLM 提炼(2026-06-12 用户反馈)。 */}
        {(chapters.length > 0 || shownotes) && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-neutral-700">
              <IconList className="h-4 w-4 text-neutral-400" />
              {chapters.length > 0 ? "章节" : "节目简介"}
            </div>
            {chapters.length > 0 ? (
              <div className="space-y-0.5">
                {chapters.map((ch, i) => (
                  <div
                    key={i}
                    className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-[13px]"
                  >
                    <span className="shrink-0 tabular-nums text-neutral-400">
                      {formatTimestamp(ch.start_sec)}
                    </span>
                    <span className="text-neutral-700">{ch.title}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="max-w-none break-words">
                <Markdown remarkPlugins={[remarkGfm]} components={shownotesComponents}>
                  {shownotes}
                </Markdown>
              </div>
            )}
          </div>
        )}

        {/* ⑤.5 本期话题脉络(奥卡姆剃刀时间轴)—— LLM 从逐字稿提炼,每节点
            时间点 · 主题 · 该时段核心观点 · 说话人,竖向时间轴呈现(2026-06-12 #4)。
            紧贴文字稿上方——它是逐字稿的「索引版」。仅 A 档(有真字幕)生成;
            非 A 档 timeline 为空数组,整段省略。 */}
        {timeline.length > 0 && (
          <div>
            <div className="mb-3 flex items-center gap-1.5 text-[13px] font-semibold text-neutral-700">
              <IconList className="h-4 w-4 text-neutral-400" />
              本期话题脉络
            </div>
            <div className="space-y-0">
              {timeline.map((seg, i) => (
                <div
                  key={i}
                  className={cn(
                    "relative border-l-2 border-neutral-200 pl-4",
                    i === timeline.length - 1 ? "pb-0" : "pb-4",
                  )}
                >
                  <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-neutral-300" />
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 tabular-nums text-[12px] font-semibold text-neutral-400">
                      {seg.ts}
                    </span>
                    <span className="text-[14px] font-semibold leading-snug text-neutral-900 break-words">
                      {seg.topic}
                    </span>
                  </div>
                  {seg.point && (
                    <p className="mt-1 text-[13px] leading-[1.6] text-neutral-600 break-words">{seg.point}</p>
                  )}
                  {seg.speaker && (
                    <div className="mt-1 flex items-center gap-1 text-[12px] text-neutral-400">
                      <IconUser className="h-3 w-3 shrink-0" />
                      {seg.speaker}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ⑥ (A 档) transcript 折叠 + 译/原 toggle（默认收起）。B/C 档无 transcript_text
            → 整段省略（§10 graceful 缺字段） */}
        {hasTranscript && (
          <details
            className="rounded-lg border border-neutral-200"
            onToggle={(e) => setTOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-neutral-700">
              <IconChevron
                className={cn(
                  "h-4 w-4 shrink-0 text-neutral-400 transition-transform",
                  tOpen && "rotate-180",
                )}
              />
              <IconFileText className="h-4 w-4 shrink-0 text-neutral-400" />
              文字稿
              {tLenLabel && <span className="ml-auto text-[11px] text-neutral-400">{tLenLabel}</span>}
            </summary>
            <div className="border-t border-neutral-200 px-3 py-3">
              {isForeign && transcriptZh && (
                <div className="mb-3">
                  <LangToggle
                    value={tTab}
                    onChange={(v) => {
                      userSwitchedTTab.current = true;
                      setTTab(v);
                    }}
                  />
                </div>
              )}
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-600">
                {transcriptToShow}
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

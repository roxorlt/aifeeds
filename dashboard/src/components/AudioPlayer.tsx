// Podcast audio player — MVP 只包浏览器原生 <audio controls>。
//
// 设计：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §10.3 / mockup #4
//   - src = 原始 <enclosure> 直链（extra.audio_url），⚠️ 绝不走 /r/ R2 反代：
//     R2 反代无 Range → seek 失效；几十 MB 串流过 1c1g 香港中转会 OOM 拖垮全站。
//   - host 不可用 / 播放失败时 fallback「在原平台收听」外链（externalUrl）。
//   - 海外播客音频直连，大陆访问可能较慢或需科学上网，始终保留兜底外链。
//   - v2 再自绘播放条 + 全局单实例；MVP 用原生 controls（零代码、最稳）。
//   - emoji 严禁当 icon —— 外链箭头 / 时钟走 inline lucide 风 SVG。

import { useState } from "react";
import { IconClock } from "./icons";

interface AudioPlayerProps {
  /** 原始 enclosure 直链（不走 /r/）。缺失或非 http(s) 时只渲染兜底外链。 */
  src?: string | null;
  /** 播放失败 / 无 src 时的兜底「在原平台收听」外链。 */
  externalUrl?: string | null;
  /** 兜底外链文案，如「在小宇宙打开」「在 Latent Space 收听」。 */
  externalLabel?: string;
}

// arrow-up-right（lucide），禁 ↗ emoji。
function IconExternal({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className || "h-3.5 w-3.5"}
      aria-hidden="true"
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}

function ExternalFallback({
  url,
  label,
  note,
}: {
  url?: string | null;
  label?: string;
  note: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-neutral-200 px-3 py-2.5 text-[13px] text-neutral-500">
      <IconClock className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
      <div className="min-w-0">
        <p className="leading-relaxed">{note}</p>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 inline-flex items-center gap-1 font-medium text-sky-600 hover:underline"
          >
            {label || "在原平台收听"}
            <IconExternal className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}

export function AudioPlayer({ src, externalUrl, externalLabel }: AudioPlayerProps) {
  const [failed, setFailed] = useState(false);
  const valid = !!src && /^https?:\/\//i.test(src);

  if (!valid || failed) {
    return (
      <ExternalFallback
        url={externalUrl}
        label={externalLabel}
        note={
          failed
            ? "音频加载失败，可在原平台收听。"
            : "本期暂无可直连音频，请在原平台收听。"
        }
      />
    );
  }

  return (
    <div>
      {/* src 是原始 enclosure 直链，浏览器原生 <audio> 直吃，不走 /r/。
          preload=none(2026-06-11 C 端速度对齐 22c27da 视频 preload=none 思路):
          metadata 也会向海外 CDN(megaphone/acast/libsyn)发请求,大陆可能挂起占
          连接;时长 UI 由 extra.duration_sec 提供,不依赖 audio 元数据,点播放才加载。 */}
      <audio
        controls
        preload="none"
        src={src ?? undefined}
        onError={() => setFailed(true)}
        onClick={(e) => e.stopPropagation()}
        className="w-full"
      >
        您的浏览器不支持音频播放。
      </audio>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-neutral-400">
        <IconClock className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          音频直连原平台、未迁 R2，海外播客大陆访问可能较慢或需科学上网；
          {externalUrl ? (
            <>
              播放失败可
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="ml-0.5 font-medium text-sky-600 hover:underline"
              >
                {externalLabel || "在原平台收听"}
              </a>
              。
            </>
          ) : (
            "播放失败请稍后重试。"
          )}
        </span>
      </p>
    </div>
  );
}

import { useRef, useState } from "react";
import type { LinkCard as LinkCardType } from "../types";
import {
  LAZY_MEDIA_LOAD_POLICY,
  getMediaPriorityTelemetryLabel,
  type MediaLoadPolicy,
} from "../lib/mediaPriority";
import { useDeferredVideoPoster } from "../lib/useDeferredVideoPoster";
import { resolveVideoPosterSource } from "../lib/videoPoster";

interface Props {
  card: LinkCardType;
  feedSource?: string;
  mediaPolicy?: MediaLoadPolicy;
}

export function LinkCard({
  card,
  feedSource,
  mediaPolicy = LAZY_MEDIA_LOAD_POLICY,
}: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const title = card.title_translated || card.title;
  const description = card.description_translated || card.description;
  const href = card.url || undefined;
  const domainLabel = card.display_url || card.domain || "";
  const videoRef = useRef<HTMLVideoElement>(null);

  // og:image 域名千变万化，加 force 让 worker /img 用 cf.image transform + R2
  // 缓存压缩，避免 CN 网络直拉外链慢导致滑动卡顿。aspect-ratio CSS 已给
  // 容器占位，无 layout shift（不需要 hardcode width/height attr）。
  const posterSrc = resolveVideoPosterSource(card.image_url, undefined, { forceProxy: true });
  const showVideo = Boolean(card.video_url) && !videoFailed;
  const showImage = !showVideo && Boolean(card.image_url) && !imageFailed;
  const { poster: deferredPoster, requestPoster } = useDeferredVideoPoster({
    videoRef,
    posterSource: showVideo ? posterSrc : undefined,
    mediaPolicy,
  });

  if (!title && !description && !card.image_url && !card.video_url) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="mt-2.5 block overflow-hidden rounded-2xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50"
      data-feed-source={showVideo || showImage ? feedSource : undefined}
      data-media-priority={
        showVideo || showImage ? getMediaPriorityTelemetryLabel(mediaPolicy) : undefined
      }
    >
      {showVideo && (
        <video
          ref={videoRef}
          // 视频站 URL 不经 proxyImg（cf.image 只处理图片）。video onError 失败
          // 时 fallback 回 image_url 渲染（视频站点 watch URL 浏览器播不了的退化）。
          src={card.video_url || undefined}
          poster={deferredPoster}
          controls
          preload="none"
          playsInline
          className="aspect-[1.91/1] w-full bg-black object-cover"
          onMouseEnter={requestPoster}
          onFocus={requestPoster}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            requestPoster();
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPlay={requestPoster}
          onError={() => setVideoFailed(true)}
        />
      )}
      {showImage && (
        <img
          src={posterSrc}
          alt=""
          loading={mediaPolicy.loading}
          fetchPriority={mediaPolicy.fetchPriority}
          className="aspect-[1.91/1] w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="p-3">
        {domainLabel && (
          <div className="mb-0.5 truncate text-[12px] text-neutral-500">
            {domainLabel}
          </div>
        )}
        {title && (
          <div className="line-clamp-2 text-[14px] font-medium text-neutral-900">
            {title}
          </div>
        )}
        {description && (
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-neutral-600">
            {description}
          </div>
        )}
      </div>
    </a>
  );
}

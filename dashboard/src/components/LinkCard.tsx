import { useRef, useState } from "react";
import type { LinkCard as LinkCardType } from "../types";
import {
  LAZY_MEDIA_LOAD_POLICY,
  getMediaPriorityTelemetryLabel,
  type MediaLoadPolicy,
} from "../lib/mediaPriority";
import { useDeferredVideoPoster } from "../lib/useDeferredVideoPoster";
import { resolveVideoPosterSource } from "../lib/videoPoster";
import { proxyVideo } from "../lib/utils";

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

  // 已在严格 allowlist 内的 og:image 走 /img；未知外链保持直连，避免生成
  // Worker 必然拒绝的 403。aspect-ratio CSS 已给容器占位，无 layout shift。
  const posterSrc = resolveVideoPosterSource(card.image_url, undefined, { forceProxy: true });
  const showVideo = Boolean(card.video_url) && !videoFailed;
  const showImage = !showVideo && Boolean(card.image_url) && !imageFailed;
  const { poster: deferredPoster, requestPoster } = useDeferredVideoPoster({
    videoRef,
    posterSource: showVideo ? posterSrc : undefined,
    mediaPolicy,
  });

  if (!title && !description && !card.image_url && !card.video_url) return null;

  const mediaContents = (
    <>
      {showVideo && (
        <video
          ref={videoRef}
          // 只有 legacy video.twimg.com 走专用 /media Range 代理；R2 与其它
          // 视频保持直连，绝不进入会做图片变换的 /img。
          src={proxyVideo(card.video_url) || undefined}
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
    </>
  );
  const textContents = (
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
      {!domainLabel && !title && !description && href && (
        <div className="text-[13px] font-medium text-sky-700">打开原文 ↗</div>
      )}
    </div>
  );
  const mediaPriority = showVideo || showImage
    ? getMediaPriorityTelemetryLabel(mediaPolicy)
    : undefined;
  const className = "mt-2.5 block overflow-hidden rounded-2xl border border-neutral-200 bg-white transition-colors hover:bg-neutral-50";

  // Native video controls cannot be descendants of an anchor. Keep playback
  // in a non-interactive card shell and make only the descriptive area a link.
  if (showVideo) return (
    <div
      className={className}
      data-feed-source={feedSource}
      data-media-priority={mediaPriority}
    >
      {mediaContents}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="block"
        >
          {textContents}
        </a>
      ) : textContents}
    </div>
  );

  const contents = <>{mediaContents}{textContents}</>;

  if (!href) return (
    <div
      className={className}
      data-feed-source={showVideo || showImage ? feedSource : undefined}
      data-media-priority={mediaPriority}
    >
      {contents}
    </div>
  );

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={className}
      data-feed-source={showVideo || showImage ? feedSource : undefined}
      data-media-priority={mediaPriority}
    >
      {contents}
    </a>
  );
}

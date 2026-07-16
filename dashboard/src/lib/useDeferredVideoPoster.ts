import { useCallback, useEffect, useState, type RefObject } from "react";
import type { MediaLoadPolicy } from "./mediaPriority";
import {
  resolveVideoPosterObserverRoot,
  shouldLoadVideoPosterImmediately,
} from "./videoPoster";

export const VIDEO_POSTER_ROOT_MARGIN = "200px 0px";

interface DeferredVideoPosterOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  posterSource?: string;
  mediaPolicy: MediaLoadPolicy;
}

interface DeferredVideoPosterResult {
  poster?: string;
  requestPoster: () => void;
}

export function useDeferredVideoPoster({
  videoRef,
  posterSource,
  mediaPolicy,
}: DeferredVideoPosterOptions): DeferredVideoPosterResult {
  const [requested, setRequested] = useState(false);
  const immediate = shouldLoadVideoPosterImmediately(mediaPolicy);
  const observationUnavailable = typeof IntersectionObserver === "undefined";
  const enabled = Boolean(posterSource) && (immediate || requested || observationUnavailable);
  const requestPoster = useCallback(() => setRequested(true), []);

  useEffect(() => {
    if (!posterSource || enabled) return;
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      requestPoster();
      observer.disconnect();
    }, {
      root: resolveVideoPosterObserverRoot(video),
      rootMargin: VIDEO_POSTER_ROOT_MARGIN,
    });
    observer.observe(video);
    return () => observer.disconnect();
  }, [enabled, posterSource, requestPoster, videoRef]);

  return {
    poster: enabled ? posterSource : undefined,
    requestPoster,
  };
}

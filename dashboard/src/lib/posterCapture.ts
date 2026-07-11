import type { RefObject } from "react";
import type { Item } from "../types";

export interface PosterCanvasHandle {
  /** 把当前 DOM 截图为 PNG blob (modern-screenshot 内部 await 字体/图片加载) */
  capture: () => Promise<Blob>;
}

export interface RenderPosterArgs {
  item: Item;
  shareUrl: string;
  sharerName: string;
  sharerAvatarUrl?: string;
}

/** 调用方拿到 blob 后自己决定下载 / Web Share / preview。 */
export async function capturePosterFromRef(
  ref: RefObject<PosterCanvasHandle | null>,
): Promise<Blob> {
  if (!ref.current) throw new Error("PosterCanvas not mounted");
  return ref.current.capture();
}

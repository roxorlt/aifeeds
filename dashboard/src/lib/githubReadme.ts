import type { MediaItem } from "../types";
import { PUBLIC_WORKER_BASE } from "./apiBase.ts";

// Resolve relative URLs in README content to the worker R2 proxy or the
// matching GitHub raw/blob URL. Keeping this outside the component module
// lets Fast Refresh treat GithubDrawerBody.tsx as a component-only module.
export function resolveGithubReadmeUrl(
  src: string | undefined,
  owner: string,
  repo: string,
  branch: string,
  type: "raw" | "page",
): string | undefined {
  if (!src) return src;
  if (/^(https?:|data:|blob:|mailto:|#)/i.test(src)) return src;
  if (src.startsWith("/r/")) return `${PUBLIC_WORKER_BASE}${src}`;
  const base =
    type === "raw"
      ? `https://raw.githubusercontent.com/${owner}/${repo}/${branch || "main"}`
      : `https://github.com/${owner}/${repo}/blob/${branch || "main"}`;
  if (src.startsWith("/")) return `${base}${src}`;
  return `${base}/${src.replace(/^\.\//, "")}`;
}

// Extract image URLs from README markdown in render order for Lightbox.
export function extractReadmeImages(
  markdown: string,
  owner: string,
  repo: string,
  branch: string,
): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  const push = (rawSrc: string) => {
    const resolved = resolveGithubReadmeUrl(rawSrc, owner, repo, branch, "raw");
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ type: "image", url: resolved });
  };
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRe.exec(markdown)) !== null) push(match[1]);
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((match = htmlRe.exec(markdown)) !== null) push(match[1]);
  return out;
}

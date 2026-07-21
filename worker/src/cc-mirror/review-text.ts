import type { Env } from "../index";
import type { DigestSource } from "../digest/config";
import { getBases } from "../digest/lib";
import { renderItem, type RenderRow } from "../digest/render";
import { renderItemBody } from "../seo/item-body";

type ReviewRow = RenderRow & { source_type?: string | null };

export interface CcReviewText {
  text: string;
  hashInput: string;
  renderError?: "render-item-failed" | "render-body-failed";
}

const REVIEW_TEXT_VERSION = 1;
const REVIEW_TEXT_MAX_CODE_POINTS = 11_000;
const HEAD_SAMPLE_CODE_POINTS = 5_000;
const MIDDLE_SAMPLE_CODE_POINTS = 3_000;
const TAIL_SAMPLE_CODE_POINTS = 3_000;

const SOURCE_MAP: Record<string, DigestSource> = {
  x_list: "x",
  github: "gh",
  product_hunt: "ph",
  hf_paper: "hf-paper",
  blog: "news",
  podcast: "news",
};

const BLOCK_TAG_RE =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
};

export function buildCcReviewText(
  row: RenderRow,
  env: Env,
): CcReviewText {
  const reviewRow = row as ReviewRow;
  const sourceType =
    typeof reviewRow.source_type === "string" ? reviewRow.source_type : "";
  const source = SOURCE_MAP[sourceType] ?? (sourceType as DigestSource);
  const safeFallbackTitle = htmlToPlainText(reviewRow.title ?? "");
  let title: string;
  try {
    const { apiBase } = getBases(env);
    title = normalizeWhitespace(
      renderItem(source, row, 1, apiBase, {
        newsCoverQualityGate: true,
        extendedIntro: true,
      }).title,
    );
  } catch {
    return finalizeReviewText(
      reviewRow,
      sourceType,
      safeFallbackTitle,
      "render-item-failed",
    );
  }

  let body: string;
  try {
    body = htmlToPlainText(renderItemBody(source, row, env));
  } catch {
    return finalizeReviewText(
      reviewRow,
      sourceType,
      title,
      "render-body-failed",
    );
  }

  const combined = normalizeWhitespace([title, body].filter(Boolean).join(" "));
  return finalizeReviewText(reviewRow, sourceType, combined);
}

function finalizeReviewText(
  row: ReviewRow,
  sourceType: string,
  combined: string,
  renderError?: CcReviewText["renderError"],
): CcReviewText {
  const normalized = normalizeWhitespace(combined);
  const text = sourceType === "github" ? stableSample(normalized) : normalized;
  const hashInput = [
    `cc-review-text:v${REVIEW_TEXT_VERSION}`,
    `item_id=${row.id}`,
    `source_type=${sourceType}`,
    `render_status=${renderError ? "error" : "ok"}`,
    `text_code_points=${Array.from(text).length}`,
    text,
  ].join("\n");

  return {
    text,
    hashInput,
    ...(renderError ? { renderError } : {}),
  };
}

function htmlToPlainText(value: string): string {
  const withoutExecutableBlocks = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const withoutTags = withoutExecutableBlocks
    .replace(BLOCK_TAG_RE, " ")
    .replace(/<[^>]*>/g, " ");
  return normalizeWhitespace(decodeHtmlEntities(withoutTags));
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi,
    (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (decimal || hex) {
        const point = Number.parseInt(decimal ?? hex ?? "", decimal ? 10 : 16);
        if (
          Number.isInteger(point)
          && point > 0
          && point <= 0x10ffff
          && !(point >= 0xd800 && point <= 0xdfff)
        ) {
          return String.fromCodePoint(point);
        }
        return "�";
      }

      return named ? (NAMED_ENTITIES[named.toLowerCase()] ?? match) : match;
    },
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stableSample(value: string): string {
  const points = Array.from(value);
  if (points.length <= REVIEW_TEXT_MAX_CODE_POINTS) return value;

  const middleStart = Math.floor(
    (points.length - MIDDLE_SAMPLE_CODE_POINTS) / 2,
  );
  return [
    ...points.slice(0, HEAD_SAMPLE_CODE_POINTS),
    ...points.slice(middleStart, middleStart + MIDDLE_SAMPLE_CODE_POINTS),
    ...points.slice(-TAIL_SAMPLE_CODE_POINTS),
  ].join("");
}

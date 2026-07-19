import { describe, expect, it } from "vitest";
import type { Env } from "../index";
import type { RenderRow } from "../digest/render";
import { buildCcReviewText } from "./review-text";

type ReviewRow = RenderRow & { source_type: string };

const env = {
  API_BASE: "https://api.example.test",
} as Env;

function row(
  source_type: string,
  overrides: Partial<ReviewRow> = {},
): ReviewRow {
  return {
    id: `${source_type}:item-1`,
    source_type,
    title: "页面标题",
    content: null,
    content_translated: null,
    author: null,
    handle: null,
    url: "https://publisher.example/article",
    media: null,
    extra: "{}",
    ...overrides,
  };
}

describe("buildCcReviewText", () => {
  it("includes the title and only the blog text that the renderer exposes", () => {
    const hiddenTail = "BLOG_HIDDEN_FULLTEXT_TAIL";
    const body = `${"这是正文摘录。".repeat(150)}${hiddenTail}`;
    const result = buildCcReviewText(
      row("blog", {
        title: "博客页面标题",
        extra: JSON.stringify({
          feed_key: "the-verge",
          ai_summary_zh: "AI 摘要",
          excerpt_zh: "编辑要点",
          body_markdown_zh: body,
        }),
      }),
      env,
    );

    expect(result.text).toContain("博客页面标题");
    expect(result.text).toContain("AI 摘要");
    expect(result.text).toContain("编辑要点");
    expect(result.text).toContain("正文摘录");
    expect(result.text).not.toContain(hiddenTail);
  });

  it("keeps podcast summary, people, chapters and shownotes but never transcripts", () => {
    const result = buildCcReviewText(
      row("podcast", {
        title: "播客页面标题",
        extra: JSON.stringify({
          show_key: "practical-ai",
          ai_summary_zh: "本期摘要",
          hosts: ["主持甲"],
          guests: ["嘉宾乙"],
          chapters: [{ start_sec: 75, title: "第一章" }],
          shownotes_zh: "<p>节目简介短摘录</p>",
          transcript: "TRANSCRIPT_SECRET_A",
          transcript_text: "TRANSCRIPT_SECRET_B",
          transcript_text_zh: "TRANSCRIPT_SECRET_C",
        }),
      }),
      env,
    );

    expect(result.text).toContain("本期摘要");
    expect(result.text).toContain("主持甲");
    expect(result.text).toContain("嘉宾乙");
    expect(result.text).toContain("01:15");
    expect(result.text).toContain("第一章");
    expect(result.text).toContain("节目简介短摘录");
    expect(result.text).not.toMatch(/TRANSCRIPT_SECRET_[ABC]/);
  });

  it("includes every rendered X thread entry and quoted post", () => {
    const result = buildCcReviewText(
      row("x_list", {
        title: "X 串标题",
        author: "主作者",
        extra: JSON.stringify({
          thread: [
            { author: "作者一", content_translated: "串内容一" },
            { handle: "@two", content: "thread content two" },
            { content_translated: "串内容三" },
          ],
          quote_of: {
            author: "被引作者",
            content_translated: "引用内容",
          },
        }),
      }),
      env,
    );

    expect(result.text).toContain("X 串标题");
    expect(result.text).toContain("串内容一");
    expect(result.text).toContain("thread content two");
    expect(result.text).toContain("串内容三");
    expect(result.text).toContain("引用内容");
  });

  it("stably samples long GitHub text from head, middle and tail within 11000 code points", () => {
    const readme = [
      "GH_HEAD_MARKER",
      "甲".repeat(6_000),
      "GH_MIDDLE_MARKER",
      "乙".repeat(6_000),
      "GH_TAIL_MARKER",
      "丙".repeat(100),
    ].join(" ");
    const input = row("github", {
      id: "github:owner/repo",
      title: "GitHub 页面标题",
      extra: JSON.stringify({ readme_translated: readme }),
    });

    const first = buildCcReviewText(input, env);
    const second = buildCcReviewText(input, env);

    expect(first.text).toContain("GitHub 页面标题");
    expect(first.text).toContain("GH_HEAD_MARKER");
    expect(first.text).toContain("GH_MIDDLE_MARKER");
    expect(first.text).toContain("GH_TAIL_MARKER");
    expect(Array.from(first.text)).toHaveLength(11_000);
    expect(second).toEqual(first);
  });

  it("removes executable HTML blocks and tags, decodes entities and normalizes whitespace", () => {
    const result = buildCcReviewText(
      row("unknown", {
        title:
          "安全&nbsp;标题 <style>.secret{}</style> <script>alert(1)</script> &amp; &#20013; &#x6587;",
        content_translated: "fallback   text\n\nwith\tspaces",
      }),
      env,
    );

    expect(result.text).toBe("安全 标题 & 中 文 fallback text with spaces");
    expect(result.text).not.toMatch(/<[^>]+>|alert|secret/);
  });

  it("returns a stable versioned hash input that separates item and source identities", () => {
    const base = row("blog", {
      id: "blog:one",
      title: "同一标题",
      extra: JSON.stringify({
        feed_key: "openai",
        ai_summary_zh: "同一正文",
      }),
    });
    const first = buildCcReviewText(base, env);
    const again = buildCcReviewText({ ...base }, env);
    const otherItem = buildCcReviewText({ ...base, id: "blog:two" }, env);
    const otherSourceRow: ReviewRow = {
      ...base,
      source_type: "podcast",
    };
    const otherSource = buildCcReviewText(otherSourceRow, env);

    expect(again.hashInput).toBe(first.hashInput);
    expect(first.hashInput).toContain("cc-review-text:v1");
    expect(first.hashInput).toContain("blog:one");
    expect(first.hashInput).toContain("source_type=blog");
    expect(first.hashInput).toContain(first.text);
    expect(otherItem.hashInput).not.toBe(first.hashInput);
    expect(otherSource.hashInput).not.toBe(first.hashInput);
  });
});

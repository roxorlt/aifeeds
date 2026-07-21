import { describe, expect, it } from "vitest";
import { FEED_REGISTRY } from "../feeds/registry";
import { resolveCcSourcePolicy } from "./source-policy";

const EXPECTED_FEED_POLICIES = [
  ["blog", "openai", "allow", "official"],
  ["blog", "google", "allow", "official"],
  ["blog", "microsoft-research", "allow", "official"],
  ["blog", "nvidia", "allow", "official"],
  ["blog", "huggingface", "allow", "official"],
  ["blog", "anthropic", "allow", "official"],
  ["blog", "mistral", "allow", "official"],
  ["blog", "stability", "allow", "official"],
  ["blog", "together", "allow", "official"],
  ["blog", "midjourney", "allow", "official"],
  ["blog", "ai21", "allow", "official"],
  ["blog", "cohere", "allow", "official"],
  ["blog", "databricks", "allow", "official"],
  ["blog", "minimax", "allow", "official"],
  ["blog", "techcrunch", "allow", "third-party-media"],
  ["blog", "the-verge", "allow", "third-party-media"],
  ["blog", "mit-tech-review", "allow", "third-party-media"],
  ["blog", "qwen", "deny", "official"],
  ["blog", "meituan-tech", "deny", "official"],
  ["blog", "minicpm", "deny", "official"],
  ["blog", "qbitai", "deny", "third-party-media"],
  ["blog", "jiqizhixin", "deny", "third-party-media"],
  ["blog", "aiera", "deny", "third-party-media"],
  ["blog", "weibo-hot-tech", "deny", "radar"],
  ["podcast", "msr-podcast", "allow", "official"],
  ["podcast", "openai-podcast", "allow", "official"],
  ["podcast", "practical-ai", "allow", "independent"],
  ["podcast", "latent-space", "allow", "independent"],
  ["podcast", "no-priors", "allow", "independent"],
  ["podcast", "eye-on-ai", "allow", "independent"],
  ["podcast", "cognitive-revolution", "allow", "independent"],
  ["podcast", "mlst", "allow", "independent"],
  ["podcast", "gradient-dissent", "allow", "independent"],
  ["podcast", "last-week-in-ai", "manual", "independent"],
  ["podcast", "lex-fridman", "manual", "independent"],
  ["podcast", "guigu101", "deny", "independent"],
  ["podcast", "onboard", "deny", "independent"],
  ["podcast", "ai-qianxian", "deny", "independent"],
  ["podcast", "zhangxiaojun", "deny", "independent"],
] as const;

function policyFor(kind: "blog" | "podcast", key: string) {
  const feed = FEED_REGISTRY.find(
    (candidate) => candidate.kind === kind && candidate.key === key,
  );
  expect(feed, `${kind}:${key} should exist`).toBeDefined();
  return feed as (typeof FEED_REGISTRY)[number];
}

describe("cc feed registry policy", () => {
  it("matches the complete curated source policy matrix", () => {
    const expected = EXPECTED_FEED_POLICIES.map(
      ([kind, key, policy, editorialType]) => ({
        id: `${kind}:${key}`,
        policy,
        editorialType,
      }),
    ).sort((left, right) => left.id.localeCompare(right.id));

    const actual = FEED_REGISTRY.map((feed) => ({
      id: `${feed.kind}:${feed.key}`,
      policy: feed.cc_policy,
      editorialType: feed.editorial_type,
    })).sort((left, right) => left.id.localeCompare(right.id));

    expect(actual).toEqual(expected);
  });

  it("requires every registered feed to declare a policy and editorial type", () => {
    for (const feed of FEED_REGISTRY) {
      expect(
        ["allow", "manual", "deny"],
        `${feed.id} cc_policy`,
      ).toContain(feed.cc_policy);
      expect(
        ["official", "third-party-media", "independent", "radar"],
        `${feed.id} editorial_type`,
      ).toContain(feed.editorial_type);
    }
  });

  it.each(["techcrunch", "the-verge", "mit-tech-review"])(
    "allows foreign third-party AI media %s",
    (key) => {
      const feed = policyFor("blog", key);
      expect(feed.cc_policy).toBe("allow");
      expect(feed.editorial_type).toBe("third-party-media");
    },
  );

  it.each(["openai", "anthropic", "minimax"])(
    "treats %s as an explicitly allowed official source",
    (key) => {
      const feed = policyFor("blog", key);
      expect(feed.cc_policy).toBe("allow");
      expect(feed.editorial_type).toBe("official");
    },
  );

  it.each(["lex-fridman", "last-week-in-ai"])(
    "requires manual review for broad independent podcast %s",
    (key) => {
      const feed = policyFor("podcast", key);
      expect(feed.cc_policy).toBe("manual");
      expect(feed.editorial_type).toBe("independent");
    },
  );

  it.each(["qbitai", "jiqizhixin", "aiera"])(
    "denies domestic third-party media %s",
    (key) => {
      const feed = policyFor("blog", key);
      expect(feed.cc_policy).toBe("deny");
      expect(feed.editorial_type).toBe("third-party-media");
    },
  );

  it("denies the domestic hot-topic radar", () => {
    const feed = policyFor("blog", "weibo-hot-tech");
    expect(feed.cc_policy).toBe("deny");
    expect(feed.editorial_type).toBe("radar");
  });

  it("denies every domestic podcast", () => {
    const domesticPodcasts = FEED_REGISTRY.filter(
      (feed) => feed.kind === "podcast" && feed.region === "domestic",
    );
    expect(domesticPodcasts.length).toBeGreaterThan(0);
    for (const feed of domesticPodcasts) {
      expect(feed.cc_policy, feed.id).toBe("deny");
      expect(feed.editorial_type, feed.id).toBe("independent");
    }
  });
});

describe("resolveCcSourcePolicy", () => {
  it("resolves blogs only through extra.feed_key", () => {
    expect(
      resolveCcSourcePolicy({
        source_type: "blog",
        extra: JSON.stringify({ feed_key: "anthropic" }),
      }),
    ).toMatchObject({
      policy: "allow",
      editorialType: "official",
      sourceKey: "anthropic",
    });

    expect(
      resolveCcSourcePolicy({
        source_type: "blog",
        extra: JSON.stringify({
          show_key: "openai",
          source_ref: "openai",
          region: "foreign",
        }),
      }),
    ).toEqual({
      policy: "deny",
      editorialType: "platform",
      reason: "unknown-source",
    });
  });

  it("resolves podcasts only through extra.show_key", () => {
    expect(
      resolveCcSourcePolicy({
        source_type: "podcast",
        extra: JSON.stringify({ show_key: "lex-fridman" }),
      }),
    ).toMatchObject({
      policy: "manual",
      editorialType: "independent",
      sourceKey: "lex-fridman",
    });

    expect(
      resolveCcSourcePolicy({
        source_type: "podcast",
        extra: JSON.stringify({
          feed_key: "practical-ai",
          source_ref: "practical-ai",
        }),
      }),
    ).toEqual({
      policy: "deny",
      editorialType: "platform",
      reason: "unknown-source",
    });
  });

  it.each([
    ["missing extra", { source_type: "blog" }],
    ["null extra", { source_type: "blog", extra: null }],
    ["malformed JSON", { source_type: "blog", extra: "{" }],
    ["JSON null", { source_type: "blog", extra: "null" }],
    ["JSON array", { source_type: "blog", extra: "[]" }],
    ["wrong key type", { source_type: "blog", extra: '{"feed_key":7}' }],
    [
      "unknown registry key",
      { source_type: "blog", extra: '{"feed_key":"does-not-exist"}' },
    ],
    [
      "unsupported source type",
      { source_type: "video", extra: '{"feed_key":"openai"}' },
    ],
  ])("fails closed for %s", (_label, row) => {
    expect(() => resolveCcSourcePolicy(row)).not.toThrow();
    expect(resolveCcSourcePolicy(row)).toEqual({
      policy: "deny",
      editorialType: "platform",
      reason: "unknown-source",
    });
  });

  it.each(["github", "product_hunt", "hf_paper", "x_list"])(
    "accepts %s only as a per-item-review candidate",
    (sourceType) => {
      const decision = resolveCcSourcePolicy({ source_type: sourceType });
      expect(decision).toMatchObject({
        policy: "allow",
        editorialType: "platform",
        sourceKey: sourceType,
      });
      expect(decision.reason).toMatch(/candidate/);
      expect(decision.reason).toMatch(/per-item-review/);
      expect(decision.reason).not.toMatch(/direct|pass-through/);
    },
  );

  it.each(["GitHub", "github_release", "product-hunt", "hf-paper", "x"])(
    "does not broaden the platform allowlist to %s",
    (sourceType) => {
      expect(resolveCcSourcePolicy({ source_type: sourceType })).toEqual({
        policy: "deny",
        editorialType: "platform",
        reason: "unknown-source",
      });
    },
  );

  it("uses kind and key together for registry lookup", () => {
    expect(
      resolveCcSourcePolicy({
        source_type: "blog",
        extra: '{"feed_key":"practical-ai"}',
      }),
    ).toEqual({
      policy: "deny",
      editorialType: "platform",
      reason: "unknown-source",
    });
    expect(
      resolveCcSourcePolicy({
        source_type: "podcast",
        extra: '{"show_key":"openai"}',
      }),
    ).toEqual({
      policy: "deny",
      editorialType: "platform",
      reason: "unknown-source",
    });
  });
});

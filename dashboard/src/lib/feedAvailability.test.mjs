import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LIVE_CHANNELS,
  OPTIMISTIC_FEED_START,
  isInitiallyLive,
  resolveChannelLive,
  resolveFeedRenderState,
} from "./feedAvailability.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Task 6 enables optimistic feed start for the atomic P1 release", () => {
  assert.equal(OPTIMISTIC_FEED_START, true);
  assert.deepEqual(DEFAULT_LIVE_CHANNELS, [
    "x_list",
    "blog,podcast",
    "product_hunt",
    "github",
    "hf_paper",
    "huodongxing",
    "clawhub",
  ]);
});

test("only the seven known production channels start optimistically", () => {
  assert.equal(isInitiallyLive("x_list", { enabled: true }), true);
  assert.equal(isInitiallyLive("blog,podcast", { enabled: true }), true);
  assert.equal(isInitiallyLive("github", { enabled: true }), true);
  assert.equal(isInitiallyLive("youtube", { enabled: true }), false);
  assert.equal(isInitiallyLive("unknown", { enabled: true }), false);
  assert.equal(isInitiallyLive("x_list", { enabled: false }), false);
});

test("pending and failed metadata use optimistic defaults only when enabled", () => {
  for (const metadataState of ["pending", "failed"]) {
    assert.equal(
      resolveChannelLive("github", {
        enabled: true,
        metadataState,
        live: new Set(),
      }),
      true,
    );
    assert.equal(
      resolveChannelLive("youtube", {
        enabled: true,
        metadataState,
        live: new Set(["youtube"]),
      }),
      false,
    );
    assert.equal(
      resolveChannelLive("github", {
        enabled: false,
        metadataState,
        live: new Set(),
      }),
      false,
    );
  }
});

test("resolved metadata reconciles both additions and removals", () => {
  const live = new Set(["youtube", "github"]);
  assert.equal(
    resolveChannelLive("youtube", {
      enabled: true,
      metadataState: "resolved",
      live,
    }),
    true,
  );
  assert.equal(
    resolveChannelLive("github", {
      enabled: true,
      metadataState: "resolved",
      live,
    }),
    true,
  );
  assert.equal(
    resolveChannelLive("x_list", {
      enabled: true,
      metadataState: "resolved",
      live,
    }),
    false,
  );
});

test("resolved metadata treats either member as making the merged channel live", () => {
  for (const sourceType of ["blog", "podcast"]) {
    assert.equal(
      resolveChannelLive("blog,podcast", {
        enabled: true,
        metadataState: "resolved",
        live: new Set([sourceType]),
      }),
      true,
    );
  }
  assert.equal(
    resolveChannelLive("blog,podcast", {
      enabled: true,
      metadataState: "resolved",
      live: new Set(),
    }),
    false,
  );
});

test("enabled Feed render state latches a committed live non-empty render", () => {
  const committedLiveRender = resolveFeedRenderState({
    enabled: true,
    metadataPlaceholder: false,
    itemCount: 3,
    hadRenderedItems: false,
  });
  assert.deepEqual(committedLiveRender, {
    placeholder: false,
    nextHadRenderedItems: true,
  });

  const laterEmptyRender = resolveFeedRenderState({
    enabled: true,
    metadataPlaceholder: true,
    itemCount: 0,
    hadRenderedItems: committedLiveRender.nextHadRenderedItems,
  });
  assert.deepEqual(laterEmptyRender, {
    placeholder: false,
    nextHadRenderedItems: true,
  });
});

test("metadata reconciliation cannot be bypassed by a late non-empty response", () => {
  const lateResponse = resolveFeedRenderState({
    enabled: true,
    metadataPlaceholder: true,
    itemCount: 3,
    hadRenderedItems: false,
  });
  assert.deepEqual(lateResponse, {
    placeholder: true,
    nextHadRenderedItems: false,
  });
});

test("disabled mode keeps metadata authoritative over stale non-empty items", () => {
  const staleCache = resolveFeedRenderState({
    enabled: false,
    metadataPlaceholder: true,
    itemCount: 3,
    hadRenderedItems: false,
  });
  assert.deepEqual(staleCache, {
    placeholder: true,
    nextHadRenderedItems: false,
  });
});

test("disabled mode preserves the metadata-driven compatibility path", () => {
  const live = new Set(["github", "podcast"]);
  for (const metadataState of ["pending", "resolved", "failed"]) {
    assert.equal(
      resolveChannelLive("github", { enabled: false, metadataState, live }),
      true,
    );
    assert.equal(
      resolveChannelLive("blog,podcast", { enabled: false, metadataState, live }),
      true,
    );
    assert.equal(
      resolveChannelLive("x_list", { enabled: false, metadataState, live }),
      false,
    );
  }
});

test("App and Feed integrate availability without gating optimistic data on metadata", () => {
  const appSource = fs.readFileSync(path.join(here, "../App.tsx"), "utf8");
  const feedSource = fs.readFileSync(path.join(here, "../components/Feed.tsx"), "utf8");

  assert.match(appSource, /resolveChannelLive\(col\.source_type/);
  assert.match(
    appSource,
    /resolveChannelLive\(col\.source_type, \{[\s\S]*?enabled: OPTIMISTIC_FEED_START/,
  );
  assert.match(appSource, /metadataState/);
  assert.match(appSource, /fetchFeedManifest\(controller\.signal\)/);
  assert.doesNotMatch(appSource, /fetchSources|fetchStats/);
  assert.doesNotMatch(appSource, /const isPlaceholder = !channelHasData\(liveSourceTypes/);
  assert.match(feedSource, /hasRenderedItemsRef/);
  assert.match(feedSource, /resolveFeedRenderState\(\{/);
  assert.match(feedSource, /enabled: OPTIMISTIC_FEED_START/);
  assert.match(feedSource, /hadRenderedItems: hasRenderedItemsRef\.current/);
  assert.match(feedSource, /hasRenderedItemsRef\.current = feedRenderState\.nextHadRenderedItems/);
});

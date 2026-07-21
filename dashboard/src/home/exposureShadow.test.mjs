import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPOSURE_SHADOW_MAX_ITEMS,
  EXPOSURE_SHADOW_RULE_VERSION,
  createExposureHistory,
  evaluateAndRecordExposure,
  evaluateExposureShadow,
  homeFamilyForSource,
  loadExposureHistory,
  recordExposure,
  saveExposureHistory,
} from "./exposureShadow.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-07-18T12:00:00.000Z");

test("every public source maps to one hidden content family", () => {
  assert.equal(homeFamilyForSource("x_list"), "dynamic");
  assert.equal(homeFamilyForSource("github"), "project");
  assert.equal(homeFamilyForSource("product_hunt"), "project");
  assert.equal(homeFamilyForSource("clawhub"), "project");
  assert.equal(homeFamilyForSource("hf_paper"), "research");
  assert.equal(homeFamilyForSource("arxiv"), "research");
  assert.equal(homeFamilyForSource("blog"), "official");
  assert.equal(homeFamilyForSource("podcast"), "official");
  assert.equal(homeFamilyForSource("huodongxing"), "event");
  assert.equal(homeFamilyForSource("youtube"), "video");
});

test("no prior exposure always yields a neutral shadow decision", () => {
  const decision = evaluateExposureShadow(
    { id: "blog:one", source_type: "blog" },
    createExposureHistory(),
    NOW,
  );
  assert.deepEqual(decision, {
    disposition: "none",
    family: "official",
    reason: "none",
    ruleVersion: EXPOSURE_SHADOW_RULE_VERSION,
  });
});

test("family-specific impression and consumption cooldowns remain distinct", () => {
  const cases = [
    ["x_list", "dynamic", "hide", 1 * DAY, "hide", 7 * DAY],
    ["github", "project", "soft_demote", 3 * DAY, "hide", 14 * DAY],
    ["hf_paper", "research", "soft_demote", 7 * DAY, "hide", 30 * DAY],
    ["blog", "official", "soft_demote", 7 * DAY, "hide", 30 * DAY],
    ["youtube", "video", "soft_demote", 7 * DAY, "hide", 30 * DAY],
    ["huodongxing", "event", "soft_demote", 1 * DAY, "soft_demote", 1 * DAY],
  ];

  for (const [
    source,
    family,
    impressionDisposition,
    impressionCooldown,
    consumedDisposition,
    consumedCooldown,
  ] of cases) {
    const item = { id: `${source}:fixture`, source_type: source };
    const impressed = recordExposure(createExposureHistory(), {
      at: NOW - HOUR,
      family,
      itemId: item.id,
      kind: "impression",
    });
    assert.deepEqual(
      evaluateExposureShadow(item, impressed, NOW),
      {
        disposition: impressionDisposition,
        family,
        reason: "impression_cooldown",
        ruleVersion: EXPOSURE_SHADOW_RULE_VERSION,
      },
      `${source} impression policy`,
    );
    assert.equal(
      evaluateExposureShadow(item, impressed, NOW + impressionCooldown).reason,
      "none",
      `${source} impression expires at its boundary`,
    );

    const consumed = recordExposure(impressed, {
      at: NOW,
      family,
      itemId: item.id,
      kind: "consumed",
    });
    assert.deepEqual(
      evaluateExposureShadow(item, consumed, NOW + HOUR),
      {
        disposition: consumedDisposition,
        family,
        reason: "consumed_cooldown",
        ruleVersion: EXPOSURE_SHADOW_RULE_VERSION,
      },
      `${source} consumption policy`,
    );
    assert.equal(
      evaluateExposureShadow(item, consumed, NOW + consumedCooldown).reason,
      "none",
      `${source} consumption expires at its boundary`,
    );
  }
});

test("ended events are shadow-hidden even without exposure history", () => {
  for (const extra of [
    { end_time: "2026-07-18T10:00:00.000Z", detail_enriched_at: NOW - DAY },
    { status: "historical", detail_enriched_at: NOW - DAY },
    { start_time: "2026-07-17T10:00:00.000Z", detail_enriched_at: NOW - 2 * DAY },
  ]) {
    const decision = evaluateExposureShadow(
      {
        id: "huodongxing:ended",
        source_type: "huodongxing",
        extra: JSON.stringify(extra),
      },
      createExposureHistory(),
      NOW,
    );
    assert.equal(decision.disposition, "hide");
    assert.equal(decision.reason, "event_expired");
  }
});

test("history is TTL-pruned, bounded to 256 items, and fails open on broken storage", () => {
  let history = createExposureHistory();
  history = recordExposure(history, {
    at: NOW - 31 * DAY,
    family: "dynamic",
    itemId: "x_list:expired",
    kind: "impression",
  });
  for (let index = 0; index < EXPOSURE_SHADOW_MAX_ITEMS + 20; index += 1) {
    history = recordExposure(history, {
      at: NOW + index,
      family: "project",
      itemId: `github:${index}`,
      kind: "impression",
    });
  }
  assert.equal(history.entries.length, EXPOSURE_SHADOW_MAX_ITEMS);
  assert.equal(history.entries.some((entry) => entry.itemId === "x_list:expired"), false);
  assert.equal(history.entries.some((entry) => entry.itemId === "github:0"), false);
  assert.equal(history.entries.some((entry) => entry.itemId === `github:${EXPOSURE_SHADOW_MAX_ITEMS + 19}`), true);

  const brokenReadStorage = {
    getItem() {
      return "{not-json";
    },
    setItem() {},
  };
  assert.deepEqual(loadExposureHistory(brokenReadStorage, NOW), createExposureHistory());

  const brokenWriteStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  assert.doesNotThrow(() => saveExposureHistory(brokenWriteStorage, history));
  assert.deepEqual(loadExposureHistory(brokenWriteStorage, NOW), createExposureHistory());
});

test("evaluate-and-record returns the prior decision and persists the new signal", () => {
  let raw = null;
  const storage = {
    getItem() {
      return raw;
    },
    setItem(_key, value) {
      raw = value;
    },
  };
  const item = { id: "github:fixture", source_type: "github" };
  const first = evaluateAndRecordExposure(storage, item, "impression", NOW);
  assert.equal(first.reason, "none");
  const second = evaluateAndRecordExposure(storage, item, "impression", NOW + HOUR);
  assert.equal(second.reason, "impression_cooldown");
  evaluateAndRecordExposure(storage, item, "consumed", NOW + 2 * HOUR);
  const history = loadExposureHistory(storage, NOW + 2 * HOUR);
  assert.equal(history.entries[0].consumedAt, NOW + 2 * HOUR);
});

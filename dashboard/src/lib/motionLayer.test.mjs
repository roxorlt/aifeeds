import assert from "node:assert/strict";
import test from "node:test";

import { exitDurationForLayer, layerClassName } from "./motionLayer.ts";

test("layer exits are shorter than their matching entrances", () => {
  assert.equal(exitDurationForLayer("modal"), 200);
  assert.equal(exitDurationForLayer("lightbox"), 200);
  assert.equal(exitDurationForLayer("sheet"), 200);
  assert.equal(exitDurationForLayer("popover"), 125);
});

test("layer state classes keep entrance and exit styling declarative", () => {
  assert.equal(layerClassName("modal", false), "motion-layer motion-layer-modal");
  assert.equal(
    layerClassName("popover", true),
    "motion-layer motion-layer-popover motion-layer-leaving",
  );
});

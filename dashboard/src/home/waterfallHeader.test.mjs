import assert from "node:assert/strict";
import test from "node:test";

import {
  WATERFALL_HEADER_HEIGHT,
  nextWaterfallHeaderRatio,
} from "./waterfallHeader.ts";

test("waterfall header remains visible in the top zone", () => {
  assert.equal(nextWaterfallHeaderRatio({ y: 0, delta: 20, ratio: 0 }), 0);
  assert.equal(nextWaterfallHeaderRatio({ y: 49, delta: 40, ratio: 0.8 }), 0);
});

test("waterfall header follows scroll distance in both directions and clamps", () => {
  assert.equal(WATERFALL_HEADER_HEIGHT, 54);
  assert.equal(nextWaterfallHeaderRatio({ y: 120, delta: 27, ratio: 0 }), 0.5);
  assert.equal(nextWaterfallHeaderRatio({ y: 120, delta: -54, ratio: 1 }), 0);
  assert.equal(nextWaterfallHeaderRatio({ y: 120, delta: 80, ratio: 0 }), 1);
});

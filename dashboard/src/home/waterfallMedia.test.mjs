import assert from "node:assert/strict";
import test from "node:test";

import {
  rankWaterfallMedia,
  waterfallMediaPolicy,
} from "./waterfallMedia.ts";

test("media ranks skip text-only cards", () => {
  assert.deepEqual(
    rankWaterfallMedia([false, false, true, true, false, true]),
    [null, null, 0, 1, null, 2],
  );
});

test("only the first real cover is high and only the first two load eagerly", () => {
  assert.deepEqual(
    waterfallMediaPolicy(0),
    { loading: "eager", fetchPriority: "high" },
  );
  assert.deepEqual(
    waterfallMediaPolicy(1),
    { loading: "eager", fetchPriority: "auto" },
  );
  assert.deepEqual(
    waterfallMediaPolicy(2),
    { loading: "lazy", fetchPriority: "auto" },
  );
  assert.deepEqual(
    waterfallMediaPolicy(null),
    { loading: "lazy", fetchPriority: "auto" },
  );
});

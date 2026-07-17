import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VIEW_MODE,
  VIEW_MODES,
  resolveViewMode,
  serializeViewCookie,
} from "./view-mode.mjs";

test("view query overrides a valid persisted cookie without accepting arbitrary values", () => {
  assert.equal(
    resolveViewMode(new URL("http://127.0.0.1/?view=waterfall"), "aifeeds_view=classic"),
    "waterfall",
  );
  assert.equal(
    resolveViewMode(new URL("http://127.0.0.1/?view=unknown"), "aifeeds_view=waterfall"),
    "waterfall",
  );
});

test("cookie parsing matches the exact token and defaults to classic", () => {
  assert.deepEqual(VIEW_MODES, ["classic", "waterfall"]);
  assert.equal(DEFAULT_VIEW_MODE, "classic");
  assert.equal(resolveViewMode(new URL("http://127.0.0.1/"), "other=1; aifeeds_view=waterfall"), "waterfall");
  assert.equal(resolveViewMode(new URL("http://127.0.0.1/"), "not_aifeeds_view=waterfall"), "classic");
  assert.equal(resolveViewMode(new URL("http://127.0.0.1/"), "aifeeds_view=waterfall-plus"), "classic");
  assert.equal(resolveViewMode(new URL("http://127.0.0.1/"), ""), "classic");
});

test("cookie serialization is bounded and rejects invalid modes", () => {
  assert.equal(
    serializeViewCookie("waterfall"),
    "aifeeds_view=waterfall; Max-Age=15552000; Path=/; SameSite=Lax",
  );
  assert.throws(() => serializeViewCookie("other"), /invalid view mode/i);
});

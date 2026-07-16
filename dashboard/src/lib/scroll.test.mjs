import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { durationForScroll } from "./scroll.ts";

const source = fs.readFileSync(new URL("./scroll.ts", import.meta.url), "utf8");

test("scroll duration is instant when there is no meaningful movement", () => {
  assert.equal(durationForScroll(0), 0);
  assert.equal(durationForScroll(0.4), 0);
});

test("scroll duration adapts to distance within the approved UI budget", () => {
  assert.equal(durationForScroll(100), 120);
  assert.equal(durationForScroll(1000), 260);
  assert.ok(durationForScroll(500) > durationForScroll(100));
  assert.ok(durationForScroll(500) < durationForScroll(1000));
});

test("programmatic scrolling is interruptible by direct user input", () => {
  assert.match(source, /addEventListener\("wheel", interrupt/);
  assert.match(source, /addEventListener\("touchstart", interrupt/);
  assert.match(source, /removeEventListener\("wheel", interrupt/);
});

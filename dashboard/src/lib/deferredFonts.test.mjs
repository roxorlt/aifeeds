import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFERRED_FONT_FALLBACK_MS,
  DEFERRED_FONT_STYLESHEET_URLS,
  injectDeferredFontStyles,
  installDeferredFonts,
  shouldSkipDeferredFonts,
} from "./deferredFonts.ts";

function createEnvironment({ readyState = "loading", connection } = {}) {
  const target = new EventTarget();
  const timers = [];
  const idle = [];
  let injections = 0;
  let currentConnection = connection;

  return {
    target,
    timers,
    idle,
    get injections() {
      return injections;
    },
    set connection(next) {
      currentConnection = next;
    },
    environment: {
      target,
      getReadyState: () => readyState,
      readConnection: () => currentConnection,
      setTimer(callback, delay) {
        const entry = { callback, delay, cancelled: false };
        timers.push(entry);
        return entry;
      },
      clearTimer(entry) {
        entry.cancelled = true;
      },
      scheduleIdle(callback, timeout) {
        const entry = { callback, timeout, cancelled: false };
        idle.push(entry);
        return entry;
      },
      cancelIdle(entry) {
        entry.cancelled = true;
      },
      inject() {
        injections += 1;
      },
    },
  };
}

test("the first pointer or keyboard interaction schedules one idle font injection", () => {
  for (const eventName of ["pointerdown", "keydown"]) {
    const fixture = createEnvironment();
    installDeferredFonts(fixture.environment);

    assert.equal(fixture.injections, 0);
    assert.equal(fixture.idle.length, 0);
    fixture.target.dispatchEvent(new Event(eventName));
    fixture.target.dispatchEvent(new Event(eventName));

    assert.equal(fixture.idle.length, 1);
    assert.equal(fixture.injections, 0);
    fixture.idle[0].callback();
    assert.equal(fixture.injections, 1);
  }
});

test("the non-interaction fallback starts at load, waits ten seconds, then idles", () => {
  const fixture = createEnvironment();
  installDeferredFonts(fixture.environment);

  assert.equal(fixture.timers.length, 0);
  fixture.target.dispatchEvent(new Event("load"));
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, DEFERRED_FONT_FALLBACK_MS);
  assert.equal(fixture.idle.length, 0);

  fixture.timers[0].callback();
  assert.equal(fixture.idle.length, 1);
  assert.equal(fixture.injections, 0);
  fixture.idle[0].callback();
  assert.equal(fixture.injections, 1);
});

test("an already complete document starts the ten-second fallback immediately", () => {
  const fixture = createEnvironment({ readyState: "complete" });
  installDeferredFonts(fixture.environment);

  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, DEFERRED_FONT_FALLBACK_MS);
});

test("save-data and slow network classes suppress proactive font requests", () => {
  assert.equal(shouldSkipDeferredFonts({ saveData: true, effectiveType: "4g" }), true);
  for (const effectiveType of ["slow-2g", "2g", "3g"]) {
    assert.equal(shouldSkipDeferredFonts({ effectiveType }), true);
  }
  assert.equal(shouldSkipDeferredFonts({ effectiveType: "4g" }), false);
  assert.equal(shouldSkipDeferredFonts(undefined), false);

  const fixture = createEnvironment({ connection: { effectiveType: "3g" } });
  installDeferredFonts(fixture.environment);
  fixture.target.dispatchEvent(new Event("pointerdown"));
  assert.equal(fixture.idle.length, 0);
  assert.equal(fixture.injections, 0);
});

test("network eligibility is read at the trigger instead of being captured at setup", () => {
  const fixture = createEnvironment({ connection: { effectiveType: "4g" } });
  installDeferredFonts(fixture.environment);
  fixture.connection = { effectiveType: "3g" };
  fixture.target.dispatchEvent(new Event("keydown"));

  assert.equal(fixture.idle.length, 0);
  assert.equal(fixture.injections, 0);
});

test("cleanup cancels pending fallback and idle work", () => {
  const beforeTrigger = createEnvironment({ readyState: "complete" });
  const disposeFallback = installDeferredFonts(beforeTrigger.environment);
  disposeFallback();
  assert.equal(beforeTrigger.timers[0].cancelled, true);
  beforeTrigger.target.dispatchEvent(new Event("keydown"));
  assert.equal(beforeTrigger.idle.length, 0);

  const afterTrigger = createEnvironment();
  const disposeIdle = installDeferredFonts(afterTrigger.environment);
  afterTrigger.target.dispatchEvent(new Event("pointerdown"));
  disposeIdle();
  assert.equal(afterTrigger.idle[0].cancelled, true);
});

test("font stylesheet injection is idempotent", () => {
  const links = [];
  const documentLike = {
    createElement() {
      return { dataset: {} };
    },
    head: {
      querySelector(selector) {
        const key = selector.match(/deferred-font="([^"]+)"/)?.[1];
        return links.find((link) => link.dataset.aifeedsDeferredFont === key) || null;
      },
      appendChild(link) {
        links.push(link);
      },
    },
  };

  injectDeferredFontStyles(documentLike);
  injectDeferredFontStyles(documentLike);

  assert.equal(links.length, DEFERRED_FONT_STYLESHEET_URLS.length);
  assert.deepEqual(
    links.map((link) => link.href),
    DEFERRED_FONT_STYLESHEET_URLS,
  );
});

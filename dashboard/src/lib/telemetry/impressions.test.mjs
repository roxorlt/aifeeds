import assert from "node:assert/strict";
import test from "node:test";

class FakeIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element) {
    this.observed.add(element);
  }

  unobserve(element) {
    this.observed.delete(element);
  }

  emit(entries) {
    this.callback(entries);
  }
}

function fakeElement() {
  return {
    getBoundingClientRect() {
      return { top: 20, bottom: 120 };
    },
  };
}

test("each observed card owns its callback and visibility timer", async (t) => {
  const originalObserver = globalThis.IntersectionObserver;
  const originalWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalDateNow = Date.now;
  const timers = [];
  let now = 1_000;

  globalThis.IntersectionObserver = FakeIntersectionObserver;
  globalThis.window = { innerHeight: 800 };
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  Date.now = () => now;

  t.after(() => {
    globalThis.IntersectionObserver = originalObserver;
    globalThis.window = originalWindow;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    FakeIntersectionObserver.instances.length = 0;
  });

  const { observeImpression } = await import(`./impressions.ts?test=${Date.now()}`);
  const first = fakeElement();
  const second = fakeElement();
  const fired = [];

  const stopFirst = observeImpression(first, () => fired.push("first"));
  observeImpression(second, () => fired.push("second"));

  const observer = FakeIntersectionObserver.instances[0];
  assert.deepEqual(observer.options, { threshold: 0.5 });
  observer.emit([
    { target: first, isIntersecting: true, intersectionRatio: 0.7 },
    { target: second, isIntersecting: true, intersectionRatio: 0.8 },
  ]);

  now += 1_000;
  timers.splice(0).forEach((callback) => callback());
  assert.deepEqual(fired, ["first", "second"]);

  observer.emit([
    { target: first, isIntersecting: true, intersectionRatio: 0.9 },
    { target: second, isIntersecting: true, intersectionRatio: 0.9 },
  ]);
  now += 1_000;
  timers.splice(0).forEach((callback) => callback());
  assert.deepEqual(fired, ["first", "second"], "each element fires at most once");

  stopFirst();
  assert.equal(observer.observed.has(first), false);
});

test("less than 50% visibility and leaving before one second do not fire", async (t) => {
  const originalObserver = globalThis.IntersectionObserver;
  const originalWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalDateNow = Date.now;
  const timers = [];
  let now = 5_000;

  globalThis.IntersectionObserver = FakeIntersectionObserver;
  globalThis.window = { innerHeight: 800 };
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  Date.now = () => now;

  t.after(() => {
    globalThis.IntersectionObserver = originalObserver;
    globalThis.window = originalWindow;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    FakeIntersectionObserver.instances.length = 0;
  });

  const { observeImpression } = await import(`./impressions.ts?test=${Date.now()}`);
  const card = fakeElement();
  let fireCount = 0;
  observeImpression(card, () => {
    fireCount += 1;
  });

  const observer = FakeIntersectionObserver.instances[0];
  observer.emit([{ target: card, isIntersecting: true, intersectionRatio: 0.49 }]);
  now += 1_000;
  timers.splice(0).forEach((callback) => callback());
  assert.equal(fireCount, 0);

  observer.emit([{ target: card, isIntersecting: true, intersectionRatio: 0.7 }]);
  now += 500;
  observer.emit([{ target: card, isIntersecting: false, intersectionRatio: 0 }]);
  now += 500;
  timers.splice(0).forEach((callback) => callback());
  assert.equal(fireCount, 0);
});

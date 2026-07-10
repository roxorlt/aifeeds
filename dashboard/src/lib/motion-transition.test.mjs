import assert from "node:assert/strict";
import test from "node:test";

class FakeTransitionTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, propertyName = "transform", target = this) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target, propertyName });
    }
  }
}

function fakeTimer() {
  let callback = null;
  return {
    setTimeoutFn(next) {
      callback = next;
      return 1;
    },
    clearTimeoutFn() {
      callback = null;
    },
    fire() {
      const next = callback;
      callback = null;
      next?.();
    },
  };
}

test("drawer activation restores open-to-open history navigation", async () => {
  const { drawerActivationMode } = await import("./motion.ts");

  assert.equal(drawerActivationMode(false, true), "enter");
  assert.equal(drawerActivationMode(true, true), "restore");
  assert.equal(drawerActivationMode(true, false), "closed");
});

test("transform settle ignores bubbled and unrelated transitions", async () => {
  const { watchTransformTransition } = await import("./motion.ts");
  const target = new FakeTransitionTarget();
  const timer = fakeTimer();
  const outcomes = [];

  watchTransformTransition(target, {
    fallbackMs: 260,
    onComplete: () => outcomes.push("complete"),
    onCancel: () => outcomes.push("cancel"),
    ...timer,
  });

  target.emit("transitionend", "transform", {});
  target.emit("transitionend", "opacity");
  assert.deepEqual(outcomes, []);

  target.emit("transitionend", "transform");
  timer.fire();
  assert.deepEqual(outcomes, ["complete"]);
});

test("transitioncancel and explicit disposal prevent stale completion", async () => {
  const { watchTransformTransition } = await import("./motion.ts");

  for (const mode of ["event", "dispose"]) {
    const target = new FakeTransitionTarget();
    const timer = fakeTimer();
    const outcomes = [];
    const dispose = watchTransformTransition(target, {
      fallbackMs: 260,
      onComplete: () => outcomes.push("complete"),
      onCancel: () => outcomes.push("cancel"),
      ...timer,
    });

    if (mode === "event") target.emit("transitioncancel", "transform");
    else dispose();
    target.emit("transitionend", "transform");
    timer.fire();

    assert.deepEqual(outcomes, mode === "event" ? ["cancel"] : []);
  }
});

test("transform settle fallback completes when the browser emits no event", async () => {
  const { watchTransformTransition } = await import("./motion.ts");
  const target = new FakeTransitionTarget();
  const timer = fakeTimer();
  let completions = 0;

  watchTransformTransition(target, {
    fallbackMs: 260,
    onComplete: () => { completions += 1; },
    ...timer,
  });
  timer.fire();

  assert.equal(completions, 1);
});

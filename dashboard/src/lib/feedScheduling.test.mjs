import assert from "node:assert/strict";
import test from "node:test";

import {
  bindQueueToVisibility,
  buildItemsPath,
  canStartBackgroundPrefetch,
  createBackgroundQueue,
  createIntentPrefetchController,
  createSingleFlightRegistry,
  executeRequestWithPolicy,
  adjacentSourceForIntent,
  getImmediateColumnCount,
  getRequestAttemptBudget,
  itemsPathMatchesSource,
  isBackgroundPrefetchDisabled,
  loadMoreLimitForViewport,
  registerMountedFeed,
  isFeedMounted,
  shouldPollFeed,
  waitForBackgroundReadiness,
} from "./feedScheduling.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("responsive first row mounts 1, 2, then 3 columns", () => {
  assert.equal(getImmediateColumnCount(0), 1);
  assert.equal(getImmediateColumnCount(767), 1);
  assert.equal(getImmediateColumnCount(768), 2);
  assert.equal(getImmediateColumnCount(1023), 2);
  assert.equal(getImmediateColumnCount(1024), 3);
  assert.equal(getImmediateColumnCount(1440), 3);
});

test("load-more uses a bounded mobile and desktop request budget", () => {
  assert.equal(loadMoreLimitForViewport(0), 12);
  assert.equal(loadMoreLimitForViewport(767), 12);
  assert.equal(loadMoreLimitForViewport(768), 16);
  assert.equal(loadMoreLimitForViewport(1440), 16);
});

test("polling is limited to a visible, online X feed in a visible document", () => {
  assert.equal(shouldPollFeed({
    sourceType: "x_list",
    feedVisible: true,
    documentVisible: true,
    online: true,
  }), true);
  for (const override of [
    { sourceType: "github" },
    { feedVisible: false },
    { documentVisible: false },
    { online: false },
  ]) {
    assert.equal(shouldPollFeed({
      sourceType: "x_list",
      feedVisible: true,
      documentVisible: true,
      online: true,
      ...override,
    }), false);
  }
});

test("adjacent intent preserves physical tab order even when a target is unavailable", () => {
  const orderedSources = ["x_list", "blog,podcast", "product_hunt", "github"];
  assert.equal(adjacentSourceForIntent("x_list", "next", orderedSources), "blog,podcast");
  assert.equal(adjacentSourceForIntent("product_hunt", "previous", orderedSources), "blog,podcast");
  assert.equal(adjacentSourceForIntent("github", "next", orderedSources), null);
  assert.equal(adjacentSourceForIntent("missing", "next", orderedSources), null);
  assert.equal(adjacentSourceForIntent("x_list", "previous", orderedSources), null);
});

test("intent prefetch deduplicates a target and cancels superseded queued intent", async () => {
  const scheduled = new Map();
  const cancelled = [];
  let nextHandle = 0;
  const controller = createIntentPrefetchController({
    schedule(callback) {
      const handle = ++nextHandle;
      scheduled.set(handle, callback);
      return handle;
    },
    cancelScheduled(handle) {
      cancelled.push(handle);
      scheduled.delete(handle);
    },
  });
  const calls = [];

  assert.equal(controller.request("github", async (source) => calls.push(source)), true);
  assert.equal(controller.request("github", async (source) => calls.push(source)), false);
  assert.equal(controller.request("hf_paper", async (source) => calls.push(source)), true);
  assert.deepEqual(cancelled, [1]);
  assert.equal(scheduled.size, 1);

  const run = [...scheduled.values()][0];
  scheduled.clear();
  run();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["hf_paper"]);

  controller.cancel();
  assert.equal(scheduled.size, 0);
});

test("intent prefetch retains only the latest queued target while another target runs", async () => {
  const scheduled = [];
  const gate = deferred();
  const calls = [];
  const controller = createIntentPrefetchController({
    schedule(callback) {
      scheduled.push(callback);
      return callback;
    },
    cancelScheduled() {},
  });

  controller.request("github", async (source) => {
    calls.push(`${source}:start`);
    await gate.promise;
    calls.push(`${source}:end`);
  });
  scheduled.shift()();
  await Promise.resolve();

  controller.request("product_hunt", async (source) => calls.push(source));
  controller.request("hf_paper", async (source) => calls.push(source));
  assert.equal(scheduled.length, 0, "queued intent must wait behind the active request");
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["github:start", "github:end", "hf_paper"]);
});

test("items paths use a stable order, encoding, and canonical composite source", () => {
  const expected = "/api/items?source_type=blog%2Cpodcast&since=2026-07-10T00%3A00%3A00Z&relevant=1&limit=12&cursor=a%2Fb%3Fc&sort=published_at&category=mcp+tools&include_suspicious=true&city=%E5%8C%97%E4%BA%AC&when=weekend&form=offline";
  assert.equal(buildItemsPath({
    form: "offline",
    city: "北京",
    source_type: ["podcast", "blog"],
    limit: 12,
    include_suspicious: true,
    cursor: "a/b?c",
    category: "mcp tools",
    relevant: 1,
    since: "2026-07-10T00:00:00Z",
    sort: "published_at",
    when: "weekend",
  }), expected);
  assert.equal(
    buildItemsPath({ limit: 12, source_type: "blog,podcast" }),
    "/api/items?source_type=blog%2Cpodcast&limit=12",
  );
});

test("per-channel in-flight matching canonicalizes composite sources without matching unrelated lists", () => {
  const composite = buildItemsPath({
    source_type: ["podcast", "blog"],
    cursor: "next",
    limit: 30,
  });
  assert.equal(itemsPathMatchesSource(composite, "blog,podcast"), true);
  assert.equal(itemsPathMatchesSource(composite, "podcast,blog"), true);
  assert.equal(itemsPathMatchesSource(composite, "github"), false);
  assert.equal(itemsPathMatchesSource("/api/items?source_type=github&limit=12", "github"), true);
  assert.equal(itemsPathMatchesSource("/api/items?limit=12", "github"), false);
});

test("single-flight returns the identical Promise and removes it after resolve", async () => {
  const registry = createSingleFlightRegistry();
  const pending = deferred();
  let calls = 0;
  const first = registry.run("/same", () => {
    calls += 1;
    return pending.promise;
  });
  const second = registry.run("/same", () => {
    calls += 1;
    return Promise.resolve("wrong");
  });

  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(registry.has("/same"), true);
  pending.resolve("ok");
  assert.equal(await first, "ok");
  await Promise.resolve();
  assert.equal(registry.has("/same"), false);
});

test("single-flight removes rejected work without creating an unhandled cleanup rejection", async () => {
  const registry = createSingleFlightRegistry();
  const pending = deferred();
  const request = registry.run("/reject", () => pending.promise);
  pending.reject(new Error("network"));
  await assert.rejects(request, /network/);
  await Promise.resolve();
  assert.equal(registry.has("/reject"), false);
});

test("an old request cleanup cannot delete a newer request for the same path", async () => {
  const registry = createSingleFlightRegistry();
  const oldRequest = deferred();
  const newRequest = deferred();
  const first = registry.run("/replace", () => oldRequest.promise);
  registry.clear("/replace");
  const second = registry.run("/replace", () => newRequest.promise);

  oldRequest.resolve("old");
  assert.equal(await first, "old");
  await Promise.resolve();
  assert.equal(registry.has("/replace"), true);
  assert.equal(registry.run("/replace", () => Promise.resolve("third")), second);

  newRequest.resolve("new");
  assert.equal(await second, "new");
});

test("a critical join promotes the retry policy of an in-flight background list request", async () => {
  const registry = createSingleFlightRegistry();
  const firstAttempt = deferred();
  let factories = 0;
  let attempts = 0;

  const background = registry.run(
    "/api/items?source_type=github&limit=12",
    "background",
    (readPurpose) => {
      factories += 1;
      return executeRequestWithPolicy({
        method: "GET",
        purpose: readPurpose,
        attempt: async () => {
          attempts += 1;
          if (attempts === 1) return firstAttempt.promise;
          return { status: 200 };
        },
        isRetryableResult: (result) => result.status >= 500,
        sleep: async () => {},
      });
    },
  );

  const critical = registry.run(
    "/api/items?source_type=github&limit=12",
    "critical",
    () => {
      factories += 1;
      return Promise.resolve({ status: 418 });
    },
  );

  assert.equal(background, critical, "the promoted caller must join the existing URL flight");
  firstAttempt.resolve({ status: 503 });
  assert.equal((await critical).status, 200);
  assert.equal(factories, 1, "promotion must not start another URL factory");
  assert.equal(attempts, 2, "the original background flight must inherit the critical retry budget");
});

test("promotion also retries a network error from the original background attempt", async () => {
  const registry = createSingleFlightRegistry();
  const firstAttempt = deferred();
  let attempts = 0;
  const path = "/api/items?source_type=hf_paper&limit=12";

  const background = registry.run(path, "background", (readPurpose) => (
    executeRequestWithPolicy({
      method: "GET",
      purpose: readPurpose,
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) return firstAttempt.promise;
        return { status: 200 };
      },
      sleep: async () => {},
    })
  ));
  const critical = registry.run(path, "critical", () => Promise.resolve({ status: 418 }));

  assert.equal(background, critical);
  firstAttempt.reject(new TypeError("Failed to fetch"));
  assert.equal((await critical).status, 200);
  assert.equal(attempts, 2);
});

test("save-data and slow connection classes disable background prefetch", () => {
  assert.equal(isBackgroundPrefetchDisabled({ saveData: true, effectiveType: "4g" }), true);
  for (const effectiveType of ["slow-2g", "2g", "3g"]) {
    assert.equal(isBackgroundPrefetchDisabled({ effectiveType }), true);
  }
  assert.equal(isBackgroundPrefetchDisabled({ effectiveType: "4g" }), false);
  assert.equal(isBackgroundPrefetchDisabled(undefined), false);
});

test("background eligibility reads the current connection for every candidate", () => {
  let connection = { effectiveType: "4g", saveData: false };
  let reads = 0;
  const readConnection = () => {
    reads += 1;
    return connection;
  };
  assert.equal(canStartBackgroundPrefetch(readConnection), true);
  connection = { effectiveType: "3g", saveData: false };
  assert.equal(canStartBackgroundPrefetch(readConnection), false);
  connection = { effectiveType: "4g", saveData: true };
  assert.equal(canStartBackgroundPrefetch(readConnection), false);
  assert.equal(reads, 3);
});

test("background queue runs exactly one task at a time", async () => {
  const queue = createBackgroundQueue();
  const firstGate = deferred();
  let active = 0;
  let maxActive = 0;
  const order = [];
  const first = queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
    active -= 1;
  });
  const second = queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("second:start");
    active -= 1;
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("hidden documents pause new queue work and visibility resumes it", async () => {
  class VisibilitySource extends EventTarget {
    hidden = true;
  }
  const source = new VisibilitySource();
  const queue = createBackgroundQueue();
  const unbind = bindQueueToVisibility(queue, source);
  let calls = 0;
  const done = queue.enqueue(async () => {
    calls += 1;
  });

  await Promise.resolve();
  assert.equal(calls, 0);
  source.hidden = false;
  source.dispatchEvent(new Event("visibilitychange"));
  await done;
  assert.equal(calls, 1);
  unbind();
});

test("background readiness resolves on LCP, first pointer, or first keyboard interaction", async () => {
  for (const [eventName, expected] of [
    ["aifeeds:lcp-settled", "lcp"],
    ["pointerdown", "interaction"],
    ["keydown", "interaction"],
  ]) {
    const target = new EventTarget();
    const readiness = waitForBackgroundReadiness({
      target,
      getReadyState: () => "loading",
      setTimer: () => { throw new Error("fallback must wait for load"); },
      clearTimer: () => {},
    });
    target.dispatchEvent(new Event(eventName));
    assert.equal(await readiness, expected);
  }
});

test("background readiness fallback starts only at load and handles an already-complete page", async () => {
  for (const readyState of ["loading", "complete"]) {
    const target = new EventTarget();
    let timerCallback = null;
    let timerDelay = null;
    const readiness = waitForBackgroundReadiness({
      target,
      getReadyState: () => readyState,
      setTimer: (callback, delay) => {
        timerCallback = callback;
        timerDelay = delay;
        return 1;
      },
      clearTimer: () => {},
    });

    if (readyState === "loading") {
      assert.equal(timerCallback, null);
      target.dispatchEvent(new Event("load"));
    }
    assert.equal(timerDelay, 8_000);
    timerCallback();
    assert.equal(await readiness, "fallback");
  }
});

test("background readiness cleanup can be aborted during StrictMode teardown", async () => {
  const target = new EventTarget();
  const controller = new AbortController();
  let settled = false;
  const readiness = waitForBackgroundReadiness({
    target,
    getReadyState: () => "loading",
    signal: controller.signal,
    setTimer: () => { throw new Error("aborted gate must not schedule fallback"); },
    clearTimer: () => {},
  });
  void readiness.then(() => { settled = true; });
  controller.abort();
  target.dispatchEvent(new Event("aifeeds:lcp-settled"));
  target.dispatchEvent(new Event("load"));
  await Promise.resolve();
  assert.equal(settled, false);
});

test("mounted Feed registrations are reference-counted and cleanup is idempotent", () => {
  const releaseFirst = registerMountedFeed("github");
  const releaseSecond = registerMountedFeed("github");
  assert.equal(isFeedMounted("github"), true);
  releaseFirst();
  releaseFirst();
  assert.equal(isFeedMounted("github"), true);
  releaseSecond();
  assert.equal(isFeedMounted("github"), false);
});

test("request budgets cap critical reads at two attempts and all other work at one", () => {
  assert.equal(getRequestAttemptBudget("GET", "critical"), 2);
  assert.equal(getRequestAttemptBudget("HEAD", "critical"), 2);
  assert.equal(getRequestAttemptBudget("GET", "background"), 1);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(getRequestAttemptBudget(method, "critical"), 1);
    assert.equal(getRequestAttemptBudget(method, "background"), 1);
  }
});

test("critical GET retries once while background GET and failing POST attempt once", async () => {
  for (const scenario of [
    { method: "GET", purpose: "critical", expected: 2 },
    { method: "GET", purpose: "background", expected: 1 },
    { method: "POST", purpose: "critical", expected: 1 },
  ]) {
    let attempts = 0;
    const sleeps = [];
    await assert.rejects(
      executeRequestWithPolicy({
        method: scenario.method,
        purpose: scenario.purpose,
        attempt: async () => {
          attempts += 1;
          throw new TypeError("Failed to fetch");
        },
        sleep: async (delay) => { sleeps.push(delay); },
      }),
      /Failed to fetch/,
    );
    assert.equal(attempts, scenario.expected);
    assert.equal(sleeps.length, Math.max(0, scenario.expected - 1));
  }
});

test("critical 5xx has no four-attempt retry tail and external abort exits immediately", async () => {
  let attempts = 0;
  const sleeps = [];
  const response = await executeRequestWithPolicy({
    method: "GET",
    purpose: "critical",
    attempt: async () => {
      attempts += 1;
      return { status: 503 };
    },
    isRetryableResult: (result) => result.status >= 500,
    sleep: async (delay) => { sleeps.push(delay); },
  });
  assert.equal(response.status, 503);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [400]);

  attempts = 0;
  const abort = new DOMException("aborted", "AbortError");
  await assert.rejects(
    executeRequestWithPolicy({
      method: "GET",
      purpose: "critical",
      attempt: async () => {
        attempts += 1;
        throw abort;
      },
      shouldStopOnError: () => true,
      sleep: async () => { throw new Error("must not sleep"); },
    }),
    (error) => error === abort,
  );
  assert.equal(attempts, 1);
});

test("an external abort during retry backoff prevents the second attempt immediately", async () => {
  const controller = new AbortController();
  const sleepStarted = deferred();
  const backoff = deferred();
  let attempts = 0;
  const request = executeRequestWithPolicy({
    method: "GET",
    purpose: "critical",
    signal: controller.signal,
    attempt: async () => {
      attempts += 1;
      throw new TypeError("Failed to fetch");
    },
    sleep: async () => {
      sleepStarted.resolve();
      await backoff.promise;
    },
  });

  await sleepStarted.promise;
  controller.abort(new DOMException("aborted", "AbortError"));
  const outcome = request.then(
    () => "resolved",
    (error) => error,
  );
  const observed = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 20)),
  ]);
  if (observed === "still-waiting") backoff.resolve();
  assert.equal(observed, controller.signal.reason);
  assert.equal(attempts, 1);
});

test("a final-result observer failure cannot trigger a duplicate network attempt", async () => {
  let attempts = 0;
  await assert.rejects(
    executeRequestWithPolicy({
      method: "GET",
      purpose: "critical",
      attempt: async () => {
        attempts += 1;
        return { status: 200 };
      },
      onFinalResult: () => {
        throw new Error("observer failed");
      },
      sleep: async () => {},
    }),
    /observer failed/,
  );
  assert.equal(attempts, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createDetailLoader } from "./detailLoader.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test("enter starts one detail read immediately and coalesces URL sync for the same entry", async () => {
  const request = deferred();
  const calls = [];
  const applied = [];
  const loader = createDetailLoader((id) => {
    calls.push(id);
    return request.promise;
  });
  const handlers = {
    onSuccess: (id, value) => applied.push([id, value]),
    onError: () => assert.fail("detail request should resolve"),
  };

  const opened = loader.enter("hf_paper:2607.00001", handlers);
  const urlSynced = loader.enter("hf_paper:2607.00001", handlers);

  assert.deepEqual(calls, ["hf_paper:2607.00001"]);
  assert.equal(opened, urlSynced);
  request.resolve({ item: { id: "hf_paper:2607.00001", extra: { full_text_zh: "full" } } });
  await opened;
  await flush();
  assert.deepEqual(applied, [[
    "hf_paper:2607.00001",
    { item: { id: "hf_paper:2607.00001", extra: { full_text_zh: "full" } } },
  ]]);
});

test("switching items ignores the old response and applies only the active detail", async () => {
  const requests = new Map([
    ["product_hunt:first", deferred()],
    ["huodongxing:second", deferred()],
  ]);
  const applied = [];
  const loader = createDetailLoader((id) => requests.get(id).promise);
  const handlers = {
    onSuccess: (id, value) => applied.push([id, value]),
    onError: () => assert.fail("detail requests should resolve"),
  };

  loader.enter("product_hunt:first", handlers);
  const active = loader.enter("huodongxing:second", handlers);
  requests.get("product_hunt:first").resolve({ item: { id: "product_hunt:first" } });
  await flush();
  assert.deepEqual(applied, []);

  requests.get("huodongxing:second").resolve({ item: { id: "huodongxing:second" } });
  await active;
  await flush();
  assert.deepEqual(applied, [[
    "huodongxing:second",
    { item: { id: "huodongxing:second" } },
  ]]);
});

test("leave invalidates pending work and reopening the same id starts a fresh read", async () => {
  const first = deferred();
  const second = deferred();
  const requests = [first, second];
  const applied = [];
  const errors = [];
  let calls = 0;
  const loader = createDetailLoader(() => requests[calls++].promise);
  const handlers = {
    onSuccess: (id, value) => applied.push([id, value]),
    onError: (id, error) => errors.push([id, error.message]),
  };

  loader.enter("hf_paper:2607.00002", handlers);
  loader.leave();
  first.resolve({ item: { id: "hf_paper:2607.00002", stale: true } });
  await flush();
  assert.deepEqual(applied, []);

  const reopened = loader.enter("hf_paper:2607.00002", handlers);
  assert.equal(calls, 2);
  second.reject(new Error("network"));
  await assert.rejects(reopened, /network/);
  await flush();
  assert.deepEqual(errors, [["hf_paper:2607.00002", "network"]]);
  assert.equal(loader.activeId(), "hf_paper:2607.00002");
});

test("a newer refresh result supersedes an older detail success for the same id", async () => {
  const oldDetail = deferred();
  let state = { item: { id: "product_hunt:item", extra: { summary: "list" } } };
  const loader = createDetailLoader(() => oldDetail.promise);
  loader.enter("product_hunt:item", {
    onSuccess: (_id, value) => { state = value; },
    onError: () => assert.fail("old detail should not fail"),
  });

  state = { item: { id: "product_hunt:item", extra: { summary: "refresh-new", full: true } } };
  loader.supersede("product_hunt:item");
  oldDetail.resolve({ item: { id: "product_hunt:item", extra: { summary: "detail-old" } } });
  await flush();

  assert.deepEqual(state, {
    item: { id: "product_hunt:item", extra: { summary: "refresh-new", full: true } },
  });
});

test("a newer refresh result supersedes an older detail error for the same id", async () => {
  const oldDetail = deferred();
  const errors = [];
  const loader = createDetailLoader(() => oldDetail.promise);
  const pending = loader.enter("huodongxing:item", {
    onSuccess: () => assert.fail("old detail should not resolve"),
    onError: (_id, error) => errors.push(error.message),
  });

  const refreshed = { item: { id: "huodongxing:item", extra: { location_full: "new" } } };
  loader.supersede("huodongxing:item");
  oldDetail.reject(new Error("old network failure"));
  await assert.rejects(pending, /old network failure/);
  await flush();

  assert.deepEqual(refreshed, {
    item: { id: "huodongxing:item", extra: { location_full: "new" } },
  });
  assert.deepEqual(errors, []);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDetailLoader } from "./detailLoader.ts";
import { runDetailSingleFlight } from "./detailSingleFlight.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSource = fs.readFileSync(path.join(here, "../api.ts"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("fetchItem owns a module-global same-id detail single-flight", () => {
  assert.match(apiSource, /runDetailSingleFlight/);
  const fetchItemBlock = apiSource.slice(
    apiSource.indexOf("export function fetchItem"),
    apiSource.indexOf("export async function refreshItem"),
  );
  assert.match(fetchItemBlock, /return runDetailSingleFlight\(id, async \(\) => \{/);
});

test("a provider transition joins one global same-id detail network request", async () => {
  const network = deferred();
  let networkRequests = 0;
  const applied = [];
  const load = (id) => runDetailSingleFlight(id, () => {
    networkRequests += 1;
    return network.promise;
  });
  const searchProvider = createDetailLoader(load);
  const dashboardProvider = createDetailLoader(load);
  const searchRequest = searchProvider.enter("github:shared", {
    onSuccess: () => applied.push("stale-search-provider"),
    onError: () => assert.fail("detail request should resolve"),
  });

  searchProvider.leave();
  const dashboardRequest = dashboardProvider.enter("github:shared", {
    onSuccess: () => applied.push("dashboard-provider"),
    onError: () => assert.fail("detail request should resolve"),
  });

  assert.equal(searchRequest, dashboardRequest);
  assert.equal(networkRequests, 1);
  network.resolve({ item: { id: "github:shared" } });
  assert.deepEqual(await dashboardRequest, { item: { id: "github:shared" } });
  await Promise.resolve();
  assert.deepEqual(applied, ["dashboard-provider"]);
});

test("detail single-flight is in-flight only and clears after settlement", async () => {
  const id = "hf_paper:cleanup";
  const first = await runDetailSingleFlight(id, async () => "first");
  await Promise.resolve();
  const second = await runDetailSingleFlight(id, async () => "second");

  assert.equal(first, "first");
  assert.equal(second, "second");
});

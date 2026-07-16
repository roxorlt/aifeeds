import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDetailLoader } from "./detailLoader.ts";
import {
  DETAIL_ROUTE_HANDOFF_GRACE_MS,
  runDetailSingleFlight,
} from "./detailSingleFlight.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSource = fs.readFileSync(path.join(here, "../api.ts"), "utf8");
const drawerSource = fs.readFileSync(path.join(here, "drawer.tsx"), "utf8");

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

test("a just-settled detail remains joinable during the route handoff grace", async () => {
  const id = "hf_paper:route-handoff";
  let networkRequests = 0;
  const firstPromise = runDetailSingleFlight(id, async () => {
    networkRequests += 1;
    return "first";
  });
  assert.equal(await firstPromise, "first");
  await Promise.resolve();

  const destinationPromise = runDetailSingleFlight(id, async () => {
    networkRequests += 1;
    return "duplicate";
  });

  assert.equal(destinationPromise, firstPromise);
  assert.equal(await destinationPromise, "first");
  assert.equal(networkRequests, 1);

  await new Promise((resolve) => setTimeout(resolve, DETAIL_ROUTE_HANDOFF_GRACE_MS + 25));
  const later = await runDetailSingleFlight(id, async () => {
    networkRequests += 1;
    return "fresh";
  });
  assert.equal(later, "fresh");
  assert.equal(networkRequests, 2);
});

test("an active optimistic drawer item survives a generic detail network failure", () => {
  const errorHandler = drawerSource.slice(
    drawerSource.indexOf("onError:"),
    drawerSource.indexOf("},\n    });", drawerSource.indexOf("onError:")) + 2,
  );

  assert.match(errorHandler, /onError:\s*\(loadedId, err: unknown\)/);
  assert.match(errorHandler, /setState\(\(current\)\s*=>/);
  assert.match(errorHandler, /current\.item\?\.id\s*===\s*loadedId/);
  assert.match(errorHandler, /\.\.\.current[\s\S]*loading:\s*false[\s\S]*error:\s*"network"/);
});

test("a definitive detail not-found still clears optimistic drawer content", () => {
  const errorHandler = drawerSource.slice(
    drawerSource.indexOf("onError:"),
    drawerSource.indexOf("},\n    });", drawerSource.indexOf("onError:")) + 2,
  );

  assert.match(errorHandler, /err instanceof ItemNotFoundError/);
  assert.match(
    errorHandler,
    /item:\s*null[\s\S]*siblings:\s*\[\][\s\S]*loading:\s*false[\s\S]*error:\s*"not_found"/,
  );
});

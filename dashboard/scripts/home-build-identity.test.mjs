import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HOME_BUILD_ID_PLACEHOLDER,
  stampHomeBuildIdentity,
  verifyHomeBuildIdentity,
} from "./home-build-identity.mjs";

const META = `<meta name="aifeeds-build-id" content="${HOME_BUILD_ID_PLACEHOLDER}">`;

async function artifact({
  waterfallAsset = "/assets/waterfall-a.js",
  waterfallCode = "export const api = 'external'",
  classicCode = "export const classic = true",
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "aifeeds-home-artifact-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "waterfall.html"),
    `<!doctype html><head>${META}<script type="module" src="${waterfallAsset}"></script></head>`,
  );
  await writeFile(path.join(root, "index.html"), "<!doctype html><main>classic</main>");
  await writeFile(path.join(root, "assets", path.basename(waterfallAsset)), waterfallCode);
  await writeFile(path.join(root, "assets", "classic.js"), classicCode);
  return root;
}

test("identical final artifacts produce one stable build identity", async () => {
  const first = await artifact();
  const second = await artifact();

  const firstId = await stampHomeBuildIdentity(first);
  const secondId = await stampHomeBuildIdentity(second);

  assert.match(firstId, /^[a-f0-9]{64}$/);
  assert.equal(firstId, secondId);
  assert.equal(await verifyHomeBuildIdentity(first), firstId);
  assert.equal(await verifyHomeBuildIdentity(second), secondId);
});

test("same source revision with different build env artifacts produces a different identity", async () => {
  const externalApi = await artifact({ waterfallCode: "export const api = 'external'" });
  const sameOriginApi = await artifact({ waterfallCode: "export const api = 'same-origin'" });

  assert.notEqual(
    await stampHomeBuildIdentity(externalApi),
    await stampHomeBuildIdentity(sameOriginApi),
  );
});

test("asset graph references participate in the build identity", async () => {
  const first = await artifact({ waterfallAsset: "/assets/waterfall-a.js" });
  const second = await artifact({ waterfallAsset: "/assets/waterfall-b.js" });

  assert.notEqual(
    await stampHomeBuildIdentity(first),
    await stampHomeBuildIdentity(second),
  );
});

test("verifier rejects a forged identity and post-stamp artifact drift", async () => {
  const forged = await artifact();
  await stampHomeBuildIdentity(forged);
  const forgedHtmlPath = path.join(forged, "waterfall.html");
  const forgedHtml = await readFile(forgedHtmlPath, "utf8");
  await writeFile(
    forgedHtmlPath,
    forgedHtml.replace(/content="[a-f0-9]{64}"/, `content="${"f".repeat(64)}"`),
  );
  await assert.rejects(() => verifyHomeBuildIdentity(forged), /does not match artifact graph/);

  const drifted = await artifact();
  await stampHomeBuildIdentity(drifted);
  await writeFile(path.join(drifted, "assets", "waterfall-a.js"), "tampered");
  await assert.rejects(() => verifyHomeBuildIdentity(drifted), /does not match artifact graph/);
});

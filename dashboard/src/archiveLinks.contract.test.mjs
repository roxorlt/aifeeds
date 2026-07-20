import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const productionNginx = readFileSync(
  new URL("../../deploy/nginx/aifeeds-seo-location.conf", import.meta.url),
  "utf8",
);
const perfStagingNginx = readFileSync(
  new URL("../../deploy/nginx/aifeeds-perf-staging-server.conf", import.meta.url),
  "utf8",
);

test("React footer exposes a visible ordinary link to the content archive", () => {
  assert.match(
    appSource,
    /<a\s+href="\/archive\/"[^>]*>\s*内容归档\s*<\/a>/,
  );
});

test("classic HTML has crawlable noscript navigation to archive and daily pages", () => {
  const noscript = [...indexHtml.matchAll(/<noscript>([\s\S]*?)<\/noscript>/gi)]
    .map((match) => match[1])
    .join("\n");
  assert.match(noscript, /href="\/archive\/"/);
  assert.match(noscript, /href="\/daily\/"/);
  assert.match(noscript, />内容归档</);
});

test("service worker leaves archive navigations to the Worker instead of the SPA shell", () => {
  assert.match(
    serviceWorker,
    /pathname === "\/archive"\s*\|\|\s*pathname\.startsWith\("\/archive\/"\)/,
  );
  assert.ok(
    serviceWorker.indexOf('pathname === "/archive"') <
      serviceWorker.indexOf('if (req.mode === "navigate")'),
  );
});

test("video watch pages and video sitemap bypass the SPA shell in every routing mirror", () => {
  assert.match(
    serviceWorker,
    /pathname\.startsWith\("\/video\/daily\/"\)/,
  );
  assert.match(
    serviceWorker,
    /pathname === "\/video-sitemap\.xml"/,
  );
  for (const [name, source] of [
    ["production nginx", productionNginx],
    ["perf staging nginx", perfStagingNginx],
  ]) {
    assert.match(source, /video\/daily\/\.\*/, `${name} misses /video/daily/*`);
    assert.match(source, /video-sitemap\\\.xml/, `${name} misses /video-sitemap.xml`);
  }
});

test("service worker leaves every home-experience navigation to SSR so the persisted view cookie stays authoritative", () => {
  assert.match(
    serviceWorker,
    /function isHomeExperiencePath\(pathname\)/,
  );
  for (const prefix of ["t", "g", "ph", "c", "e", "h", "o", "y"]) {
    assert.ok(
      serviceWorker.includes(`^\\/${prefix}\\/`),
      `missing home-experience route /${prefix}/`,
    );
  }
  assert.match(serviceWorker, /if\s*\(isHomeExperiencePath\(url\.pathname\)\)\s*return;/);
  assert.ok(
    serviceWorker.indexOf("isHomeExperiencePath(url.pathname)") <
      serviceWorker.indexOf('if (req.mode === "navigate")'),
  );
});

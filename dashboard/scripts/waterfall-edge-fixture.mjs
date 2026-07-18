#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { handleHomeRuntime } from "../functions/home-runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "..");
const dist = path.join(dashboard, "dist");
const rendererUrl = pathToFileURL(path.join(dashboard, "dist-ssr/render-waterfall.js"));
const { renderWaterfall } = await import(rendererUrl.href);
const PORT = 4187;
const ORIGIN = `https://localhost:${PORT}`;
const SQUARE_COVER = `
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#eef2ff"/>
        <stop offset="1" stop-color="#dbeafe"/>
      </linearGradient>
    </defs>
    <rect width="640" height="640" rx="40" fill="url(#background)"/>
    <circle cx="320" cy="268" r="132" fill="#ffffff" fill-opacity=".82"/>
    <path d="M238 300l58-58 48 48 38-38 66 66H238z" fill="#6366f1"/>
    <text x="320" y="460" text-anchor="middle" font-family="system-ui, sans-serif"
      font-size="40" font-weight="700" fill="#1e293b">AI Feeds</text>
  </svg>
`;
const SOURCES = Object.freeze([
  "x_list",
  "blog",
  "podcast",
  "github",
  "product_hunt",
  "hf_paper",
  "huodongxing",
  "clawhub",
  "youtube",
]);

function fixtureNumber(value) {
  return String(value).padStart(2, "0");
}

function sourceId(source, number) {
  const suffix = fixtureNumber(number);
  if (source === "github") return `fixture-owner/repo-${suffix}`;
  if (source === "product_hunt") return `fixture-product-${suffix}:2026-07-17`;
  if (source === "hf_paper") return `2607.${String(number).padStart(5, "0")}`;
  if (source === "huodongxing") return `585989494${String(number).padStart(4, "0")}`;
  return `fixture-${suffix}`;
}

function fixtureItem(number) {
  const source = SOURCES[(number - 1) % SOURCES.length];
  const source_id = sourceId(source, number);
  const longTail = "用于验证瀑布流在真实服务端渲染、水合和自适应布局下仍保持稳定顺序。".repeat(
    (number % 3) + 1,
  );
  return {
    id: `${source}:${source_id}`,
    source_type: source,
    source_id,
    title: `本地边缘验收条目 ${fixtureNumber(number)}`,
    content: longTail,
    content_translated: null,
    author: "AI-Feeds E2E",
    handle: "aifeeds_e2e",
    url: "https://example.com/aifeeds-local-fixture",
    media: [],
    metrics: {},
    published_at: `2026-07-${String(Math.max(1, 18 - number)).padStart(2, "0")}T08:00:00.000Z`,
    scraped_at: "2026-07-17T08:00:00.000Z",
    is_relevant: 1,
    is_hot: 0,
    matched_by: null,
    lang: "zh",
    extra: {
      title_zh: `本地边缘验收条目 ${fixtureNumber(number)}`,
      ai_summary_zh: longTail,
      ...(number === 2 ? {
        cover_variants: [{
          url: "/r/waterfall-fixture-square.webp",
          width: 640,
          height: 640,
          format: "webp",
        }],
      } : {}),
    },
  };
}

const allItems = Object.freeze(Array.from({ length: 20 }, (_, index) => fixtureItem(index + 1)));

async function localTlsOptions() {
  const tlsDir = path.join(dashboard, "dist-ssr/local-tls");
  const keyPath = path.join(tlsDir, "localhost-key.pem");
  const certificatePath = path.join(tlsDir, "localhost-cert.pem");
  try {
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
    return { key, cert };
  } catch {
    await mkdir(tlsDir, { recursive: true });
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ], { stdio: "ignore" });
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
    return { key, cert };
  }
}

function homeFeedPage(cursor) {
  const pageTwo = cursor === "fixture-page-2";
  return {
    view_mode: "waterfall",
    ranking_version: 2,
    generated_at: "2026-07-17T08:00:00.000Z",
    items: pageTwo ? allItems.slice(12) : allItems.slice(0, 12),
    next_cursor: pageTwo ? null : "fixture-page-2",
    has_more: !pageTwo,
  };
}

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

async function assetResponse(request) {
  const url = new URL(request.url);
  const decoded = decodeURIComponent(url.pathname);
  const pathname = decoded === "/"
    ? "/index.html"
    : decoded === "/waterfall"
      ? "/waterfall.html"
      : decoded;
  const relative = path.posix.normalize(pathname).replace(/^\/+/u, "");
  const absolute = path.resolve(dist, relative);
  if (absolute !== dist && !absolute.startsWith(`${dist}${path.sep}`)) {
    return new Response("not found", { status: 404 });
  }
  try {
    const body = await readFile(absolute);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[path.extname(absolute)] ?? "application/octet-stream",
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-store",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function itemFromDetailPath(pathname) {
  const raw = pathname.slice("/api/items/".length).split("/")[0];
  const id = decodeURIComponent(raw);
  return allItems.find((item) => item.id === id) ?? allItems[0];
}

async function apiResponse(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/track") return json({ accepted: true }, 202);
  if (url.pathname === "/api/auth/me") return json({ user: null });
  if (url.pathname === "/api/feed-manifest") {
    return json({
      live_source_types: [...SOURCES],
      labels: { x_list: "动态" },
      generated_at: "2026-07-17T08:00:00.000Z",
    });
  }
  if (request.method === "GET" && url.pathname === "/api/items") {
    const requested = url.searchParams.get("source_type")?.split(",") ?? ["x_list"];
    return json({
      items: requested.map((source) => allItems.find((item) => item.source_type === source)).filter(Boolean),
      next_cursor: null,
      has_more: false,
      query_time_ms: 1,
    });
  }
  if (request.method === "POST" && /\/refresh(?:-hf-discussion)?$/u.test(url.pathname)) {
    return json({ refreshed: false, source_type: "x_list", reason: "throttled" });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/items/")) {
    const item = itemFromDetailPath(url.pathname);
    return json({ item, siblings: allItems.slice(0, 12), siblings_has_more: false });
  }
  return json({});
}

function isHomeRuntimePath(pathname) {
  return pathname === "/"
    || pathname === "/_home/feed"
    || /^\/(?:t|c|e|h|o|y)\/[^/]+$/u.test(pathname)
    || /^\/(?:g|ph)\/[^/]+\/[^/]+$/u.test(pathname);
}

function nodeRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(new URL(req.url ?? "/", ORIGIN), {
    method: req.method ?? "GET",
    headers,
  });
}

async function writeNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (response.body === null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(await localTlsOptions(), async (req, res) => {
  try {
    const request = nodeRequest(req);
    const url = new URL(request.url);
    let response;
    if (url.pathname.startsWith("/api/")) {
      response = await apiResponse(request);
    } else if (url.pathname.startsWith("/r/")) {
      response = new Response(SQUARE_COVER, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } else if (isHomeRuntimePath(url.pathname)) {
      const failHomeApi = url.searchParams.get("fixture_api") === "fail";
      response = await handleHomeRuntime(request, {
        ASSETS: { fetch: assetResponse },
        HOME_API: {
          async fetch(apiRequest) {
            if (
              apiRequest.headers.get("X-Home-Renderer-Token") !== "local-renderer-token"
              || failHomeApi
            ) {
              return json({ error: "fixture home API unavailable" }, 503);
            }
            const apiUrl = new URL(apiRequest.url);
            return new Response(JSON.stringify(homeFeedPage(apiUrl.searchParams.get("cursor"))), {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Server-Timing": "d1;dur=1",
              },
            });
          },
        },
        HOME_EXPERIENCE_ENABLED: "true",
        HOME_RENDERER_TOKEN: "local-renderer-token",
      }, { renderWaterfall });
    } else {
      response = await assetResponse(request);
    }
    await writeNodeResponse(res, response);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`waterfall edge fixture listening on ${ORIGIN}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

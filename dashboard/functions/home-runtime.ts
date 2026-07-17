import type { HomeFeedResponse } from "../src/types";
import { parseInitialHomeFeed } from "../src/home/homeData.ts";
import {
  expireHomeViewCookie,
  isHomeExperienceEnabled,
  isHomeExperiencePath,
  resolveHomeView,
} from "../src/home/viewMode.ts";

export const SSR_MARKUP_SENTINEL = "<!--__AIFEEDS_SSR_MARKUP__-->";
export const INITIAL_DATA_SENTINEL = "__AIFEEDS_INITIAL_DATA__";

const HOME_FEED_PATH = "/_home/feed";
const HOME_API_TIMEOUT_MS = 2_000;
const HOME_CACHE_TTL_SECONDS = 30;

export type FetchBinding = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

export type HomeRuntimeEnv = Readonly<{
  ASSETS: FetchBinding;
  HOME_API?: FetchBinding;
  HOME_EXPERIENCE_ENABLED?: string;
  HOME_RENDERER_TOKEN?: string;
}>;

export type HomeRuntimeCache = Readonly<{
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}>;

export type HomeRuntimeDeps = Readonly<{
  renderWaterfall(data: HomeFeedResponse, location: string): Promise<string>;
  cache?: HomeRuntimeCache;
  waitUntil?(promise: Promise<unknown>): void;
}>;

function htmlHeaders(source?: Headers): Headers {
  const headers = new Headers(source);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.delete("Content-Length");
  headers.delete("ETag");
  return headers;
}

function jsonHeaders(source?: Headers): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  const serverTiming = source?.get("Server-Timing");
  if (serverTiming) headers.set("Server-Timing", serverTiming);
  return headers;
}

function responseForMethod(
  request: Request,
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  return new Response(request.method === "HEAD" ? null : body, init);
}

function injectHomeMetadata(html: string, mode: "classic" | "waterfall"): string {
  if (!/<html\b/iu.test(html)) throw new Error("missing html element");
  return html.replace(
    /<html\b/iu,
    `<html data-home-view-available="true" data-home-view="${mode}"`,
  );
}

function safeInitialJson(data: HomeFeedResponse): string {
  return JSON.stringify(data)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function assetRequest(source: Request, pathname: string): Request {
  const url = new URL(source.url);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return new Request(url, {
    method: "GET",
    headers: {
      Accept: "text/html",
      "User-Agent": source.headers.get("User-Agent") ?? "",
    },
  });
}

async function classicResponse(
  request: Request,
  env: HomeRuntimeEnv,
  diagnostic: "disabled" | "classic" | "fallback",
  available: boolean,
): Promise<Response> {
  try {
    const asset = await env.ASSETS.fetch(assetRequest(request, "/index.html"));
    let html = await asset.text();
    if (available) html = injectHomeMetadata(html, "classic");
    const headers = htmlHeaders(asset.headers);
    headers.set("X-AIFeeds-Home-SSR", diagnostic);
    headers.set("Cache-Control", "private, no-store");
    if (diagnostic === "fallback") headers.set("Set-Cookie", expireHomeViewCookie());
    return responseForMethod(request, html, { status: 200, headers });
  } catch {
    const headers = htmlHeaders();
    headers.set("X-AIFeeds-Home-SSR", diagnostic);
    headers.set("Cache-Control", "private, no-store");
    if (diagnostic === "fallback") headers.set("Set-Cookie", expireHomeViewCookie());
    return responseForMethod(
      request,
      "<!doctype html><html lang=\"zh-CN\"><body><a href=\"/\">返回经典首页</a></body></html>",
      { status: 200, headers },
    );
  }
}

function boundedFeedSearch(url: URL): string {
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(48, Math.max(12, rawLimit))
    : 24;
  const search = new URLSearchParams({ limit: String(limit) });
  const cursor = url.searchParams.get("cursor");
  if (cursor && cursor.length <= 1_024) search.set("cursor", cursor);
  return search.toString();
}

async function fetchHomeFeed(
  env: HomeRuntimeEnv,
  search: string,
): Promise<{ data: HomeFeedResponse; response: Response }> {
  if (!env.HOME_API || !env.HOME_RENDERER_TOKEN) throw new Error("home binding unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOME_API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await env.HOME_API.fetch(new Request(
      `https://home-api.internal/api/home-feed?${search}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Home-Renderer-Token": env.HOME_RENDERER_TOKEN,
        },
        signal: controller.signal,
      },
    ));
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error("home API unavailable");
  const value: unknown = await response.json();
  const data = parseInitialHomeFeed(JSON.stringify(value));
  return { data, response };
}

function waterfallCacheRequest(): Request {
  return new Request("https://aifeeds-home-cache.invalid/waterfall-root-v1");
}

async function cachedWaterfall(
  request: Request,
  deps: HomeRuntimeDeps,
): Promise<Response | null> {
  if (!deps.cache || new URL(request.url).pathname !== "/") return null;
  const cached = await deps.cache.match(waterfallCacheRequest());
  if (!cached) return null;
  const headers = htmlHeaders(cached.headers);
  headers.set("X-AIFeeds-Home-SSR", "waterfall-cache");
  return responseForMethod(request, await cached.text(), {
    status: cached.status,
    headers,
  });
}

async function renderWaterfallResponse(
  request: Request,
  env: HomeRuntimeEnv,
  deps: HomeRuntimeDeps,
): Promise<Response> {
  const cacheHit = await cachedWaterfall(request, deps);
  if (cacheHit) return cacheHit;

  const url = new URL(request.url);
  const [{ data, response: apiResponse }, templateResponse] = await Promise.all([
    fetchHomeFeed(env, boundedFeedSearch(new URL("https://internal/?limit=24"))),
    env.ASSETS.fetch(assetRequest(request, "/waterfall.html")),
  ]);
  if (!templateResponse.ok) throw new Error("waterfall template unavailable");
  const template = await templateResponse.text();
  if (
    !template.includes(SSR_MARKUP_SENTINEL)
    || !template.includes(INITIAL_DATA_SENTINEL)
  ) {
    throw new Error("waterfall template markers missing");
  }

  const markup = await deps.renderWaterfall(data, `${url.pathname}${url.search}`);
  const html = injectHomeMetadata(
    template
      .replace(SSR_MARKUP_SENTINEL, markup)
      .replace(INITIAL_DATA_SENTINEL, safeInitialJson(data)),
    "waterfall",
  );
  const headers = htmlHeaders(templateResponse.headers);
  headers.set("X-AIFeeds-Home-SSR", "waterfall");
  headers.set(
    "Cache-Control",
    `public, max-age=0, s-maxage=${HOME_CACHE_TTL_SECONDS}`,
  );
  const apiTiming = apiResponse.headers.get("Server-Timing");
  if (apiTiming) headers.set("Server-Timing", apiTiming);
  const response = responseForMethod(request, html, { status: 200, headers });

  if (deps.cache && url.pathname === "/" && request.method === "GET") {
    const cacheHeaders = new Headers(headers);
    cacheHeaders.set("X-AIFeeds-Home-SSR", "waterfall-cache");
    const put = deps.cache.put(
      waterfallCacheRequest(),
      new Response(html, { status: 200, headers: cacheHeaders }),
    );
    deps.waitUntil?.(put);
  }
  return response;
}

async function proxyHomeFeed(
  request: Request,
  env: HomeRuntimeEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const mode = resolveHomeView({
    url,
    cookieHeader: request.headers.get("Cookie") ?? "",
    enabled: isHomeExperienceEnabled(env.HOME_EXPERIENCE_ENABLED),
  });
  if (mode !== "waterfall") {
    return Response.json({ error: "not_found" }, {
      status: 404,
      headers: jsonHeaders(),
    });
  }
  try {
    const { data, response } = await fetchHomeFeed(env, boundedFeedSearch(url));
    const headers = jsonHeaders(response.headers);
    headers.set("X-AIFeeds-Home-SSR", "feed");
    return responseForMethod(request, JSON.stringify(data), {
      status: 200,
      headers,
    });
  } catch {
    return Response.json({ error: "home_feed_unavailable" }, {
      status: 503,
      headers: jsonHeaders(),
    });
  }
}

export async function handleHomeRuntime(
  request: Request,
  env: HomeRuntimeEnv,
  deps: HomeRuntimeDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const enabled = isHomeExperienceEnabled(env.HOME_EXPERIENCE_ENABLED);

  if (url.pathname === HOME_FEED_PATH) {
    if (!enabled) {
      return Response.json({ error: "not_found" }, {
        status: 404,
        headers: jsonHeaders(),
      });
    }
    return proxyHomeFeed(request, env);
  }

  if (!isHomeExperiencePath(url.pathname)) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-AIFeeds-Home-SSR", "pass");
    return responseForMethod(request, await response.text(), {
      status: response.status,
      headers,
    });
  }

  if (!enabled) return classicResponse(request, env, "disabled", false);

  const mode = resolveHomeView({
    url,
    cookieHeader: request.headers.get("Cookie") ?? "",
    enabled,
  });
  if (mode === "classic") return classicResponse(request, env, "classic", true);

  try {
    return await renderWaterfallResponse(request, env, deps);
  } catch {
    return classicResponse(request, env, "fallback", true);
  }
}

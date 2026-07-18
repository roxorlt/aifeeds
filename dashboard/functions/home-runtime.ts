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
type HomeSsrState = "classic" | "generated" | "fresh" | "stale" | "fallback";

const HOME_FEED_PATH = "/_home/feed";
const HOME_API_TIMEOUT_MS = 2_000;
const HOME_CACHE_FRESH_SECONDS = 60;
const HOME_CACHE_MAX_STALE_SECONDS = 10 * 60;
const HOME_CACHE_RETENTION_SECONDS = 24 * 60 * 60;
const HOME_CACHE_GENERATED_AT = "X-AIFeeds-Home-Generated-At";
const HOME_CACHE_AGE = "X-AIFeeds-Home-Age";
const HOME_CACHE_FRESHNESS = "X-AIFeeds-Home-Freshness";

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
  now?(): number;
}>;

type GeneratedWaterfall = Readonly<{
  html: string;
  headers: Headers;
  generatedAtMs: number;
}>;

type WaterfallTemplate = Readonly<{
  html: string;
  headers: Headers;
  buildIdentity: string;
}>;

type WaterfallRefreshFlight = Readonly<{
  generated: Promise<GeneratedWaterfall>;
  completed: Promise<void>;
}>;

const waterfallRefreshFlights = new WeakMap<
  HomeRuntimeCache,
  Map<string, WaterfallRefreshFlight>
>();

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

function stampHomeSsrState(html: string, state: HomeSsrState): string {
  if (/data-home-ssr="[^"]*"/iu.test(html)) {
    return html.replace(/data-home-ssr="[^"]*"/iu, `data-home-ssr="${state}"`);
  }
  return html.replace(/<html\b/iu, `<html data-home-ssr="${state}"`);
}

function injectHomeMetadata(
  html: string,
  mode: "classic" | "waterfall",
  state: HomeSsrState = mode === "waterfall" ? "generated" : "classic",
): string {
  if (!/<html\b/iu.test(html)) throw new Error("missing html element");
  return stampHomeSsrState(html.replace(
    /<html\b/iu,
    `<html data-home-view-available="true" data-home-view="${mode}"`,
  ), state);
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
    if (available) {
      html = injectHomeMetadata(
        html,
        "classic",
        diagnostic === "fallback" ? "fallback" : "classic",
      );
    }
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
    const fallbackHtml = available
      ? injectHomeMetadata(
          "<!doctype html><html lang=\"zh-CN\"><body><a href=\"/\">返回经典首页</a></body></html>",
          "classic",
          diagnostic === "fallback" ? "fallback" : "classic",
        )
      : "<!doctype html><html lang=\"zh-CN\"><body><a href=\"/\">返回经典首页</a></body></html>";
    return responseForMethod(
      request,
      fallbackHtml,
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

function waterfallCacheRequest(
  request: Request,
  buildIdentity: string,
): Request {
  const hostname = encodeURIComponent(new URL(request.url).hostname.toLowerCase());
  return new Request(
    `https://aifeeds-home-cache.invalid/${buildIdentity}/${hostname}/waterfall-root`,
  );
}

function nowMs(deps: HomeRuntimeDeps): number {
  const value = deps.now?.() ?? Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function publicWaterfallCacheEligible(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  if (url.pathname !== "/" || url.search !== "") return false;
  const cookie = request.headers.get("Cookie") ?? "";
  return !/(?:^|;\s*)xlist_sid(?:_stg)?=/u.test(cookie);
}

function cacheAgeSeconds(response: Response, currentTimeMs: number): number | null {
  const generatedAt = Date.parse(response.headers.get(HOME_CACHE_GENERATED_AT) ?? "");
  if (!Number.isFinite(generatedAt)) return null;
  return Math.max(0, Math.floor((currentTimeMs - generatedAt) / 1_000));
}

async function cachedWaterfall(
  request: Request,
  deps: HomeRuntimeDeps,
  cacheRequest: Request,
): Promise<{ response: Response; ageSeconds: number } | null> {
  if (!deps.cache || !publicWaterfallCacheEligible(request)) return null;
  let cached: Response | undefined;
  try {
    cached = await deps.cache.match(cacheRequest);
  } catch {
    return null;
  }
  if (!cached || cached.status !== 200) return null;
  const ageSeconds = cacheAgeSeconds(cached, nowMs(deps));
  if (ageSeconds === null) return null;
  const headers = htmlHeaders(cached.headers);
  const freshness: "fresh" | "stale" = ageSeconds <= HOME_CACHE_FRESH_SECONDS
    ? "fresh"
    : "stale";
  headers.set(
    "X-AIFeeds-Home-SSR",
    freshness === "fresh" ? "waterfall-cache" : "waterfall-stale",
  );
  headers.set(HOME_CACHE_FRESHNESS, freshness);
  headers.set(HOME_CACHE_AGE, String(Math.min(ageSeconds, HOME_CACHE_RETENTION_SECONDS)));
  headers.set("Cache-Control", "private, no-store");
  return {
    ageSeconds,
    response: responseForMethod(request, stampHomeSsrState(await cached.text(), freshness), {
      status: cached.status,
      headers,
    }),
  };
}

async function loadWaterfallTemplate(
  request: Request,
  env: HomeRuntimeEnv,
): Promise<WaterfallTemplate> {
  // Cloudflare Pages canonicalizes HTML assets to extensionless clean URLs.
  // Asking ASSETS for /waterfall.html returns a 308, which must not make an
  // otherwise healthy waterfall request fail open to classic mode.
  const templateResponse = await env.ASSETS.fetch(assetRequest(request, "/waterfall"));
  if (!templateResponse.ok) throw new Error("waterfall template unavailable");
  const html = await templateResponse.text();
  if (
    !html.includes(SSR_MARKUP_SENTINEL)
    || !html.includes(INITIAL_DATA_SENTINEL)
  ) {
    throw new Error("waterfall template markers missing");
  }
  const buildIdentity = html.match(
    /<meta\s+name=["']aifeeds-build-id["']\s+content=["']([a-f0-9]{64})["'][^>]*>/iu,
  )?.[1];
  if (!buildIdentity) throw new Error("waterfall build identity missing");
  return {
    html,
    headers: htmlHeaders(templateResponse.headers),
    buildIdentity,
  };
}

async function generateWaterfall(
  request: Request,
  env: HomeRuntimeEnv,
  deps: HomeRuntimeDeps,
  template: WaterfallTemplate,
): Promise<GeneratedWaterfall> {
  const url = new URL(request.url);
  const { data, response: apiResponse } = await fetchHomeFeed(
    env,
    boundedFeedSearch(new URL("https://internal/?limit=24")),
  );
  const markup = await deps.renderWaterfall(data, `${url.pathname}${url.search}`);
  const html = injectHomeMetadata(
    template.html
      .replace(SSR_MARKUP_SENTINEL, markup)
      .replace(INITIAL_DATA_SENTINEL, safeInitialJson(data)),
    "waterfall",
  );
  const headers = htmlHeaders(template.headers);
  const apiTiming = apiResponse.headers.get("Server-Timing");
  if (apiTiming) headers.set("Server-Timing", apiTiming);
  return {
    html,
    headers,
    generatedAtMs: nowMs(deps),
  };
}

function cacheResponse(generated: GeneratedWaterfall): Response {
  const headers = htmlHeaders(generated.headers);
  headers.set("X-AIFeeds-Home-SSR", "waterfall-cache");
  headers.set(
    "Cache-Control",
    `public, max-age=0, s-maxage=${HOME_CACHE_RETENTION_SECONDS}`,
  );
  headers.set(HOME_CACHE_GENERATED_AT, new Date(generated.generatedAtMs).toISOString());
  headers.delete(HOME_CACHE_AGE);
  headers.delete(HOME_CACHE_FRESHNESS);
  return new Response(generated.html, {
    status: 200,
    headers,
  });
}

function startWaterfallRefresh(
  request: Request,
  env: HomeRuntimeEnv,
  deps: HomeRuntimeDeps,
  template: WaterfallTemplate,
  cacheRequest: Request,
): { flight: WaterfallRefreshFlight; started: boolean } {
  const cache = deps.cache;
  if (!cache) throw new Error("waterfall cache unavailable");
  let flights = waterfallRefreshFlights.get(cache);
  if (!flights) {
    flights = new Map();
    waterfallRefreshFlights.set(cache, flights);
  }
  const flightKey = cacheRequest.url;
  const active = flights.get(flightKey);
  if (active) return { flight: active, started: false };

  const generated = generateWaterfall(request, env, deps, template);
  const completed = generated
    .then(async (value) => {
      await cache.put(cacheRequest, cacheResponse(value));
    })
    .finally(() => {
      const activeFlights = waterfallRefreshFlights.get(cache);
      if (activeFlights?.get(flightKey) === flight) {
        activeFlights.delete(flightKey);
        if (activeFlights.size === 0) waterfallRefreshFlights.delete(cache);
      }
    });
  const flight: WaterfallRefreshFlight = { generated, completed };
  flights.set(flightKey, flight);
  return { flight, started: true };
}

function keepRefreshAlive(
  deps: HomeRuntimeDeps,
  flight: WaterfallRefreshFlight,
  started: boolean,
): void {
  if (!started) return;
  const guarded = flight.completed.catch(() => {
    // Keep the last known-good snapshot. The next request may retry.
  });
  if (deps.waitUntil) deps.waitUntil(guarded);
  else void guarded;
}

function generatedWaterfallResponse(
  request: Request,
  generated: GeneratedWaterfall,
): Response {
  const headers = htmlHeaders(generated.headers);
  headers.set("X-AIFeeds-Home-SSR", "waterfall");
  headers.set(HOME_CACHE_FRESHNESS, "generated");
  headers.set(HOME_CACHE_AGE, "0");
  headers.set("Cache-Control", "private, no-store");
  return responseForMethod(request, generated.html, { status: 200, headers });
}

async function renderWaterfallResponse(
  request: Request,
  env: HomeRuntimeEnv,
  deps: HomeRuntimeDeps,
): Promise<Response> {
  const template = await loadWaterfallTemplate(request, env);
  if (!deps.cache || !publicWaterfallCacheEligible(request)) {
    return generatedWaterfallResponse(
      request,
      await generateWaterfall(request, env, deps, template),
    );
  }

  const cacheRequest = waterfallCacheRequest(request, template.buildIdentity);
  const cached = await cachedWaterfall(request, deps, cacheRequest);
  if (cached && cached.ageSeconds <= HOME_CACHE_FRESH_SECONDS) {
    return cached.response;
  }
  if (cached && cached.ageSeconds <= HOME_CACHE_MAX_STALE_SECONDS) {
    const refresh = startWaterfallRefresh(request, env, deps, template, cacheRequest);
    keepRefreshAlive(deps, refresh.flight, refresh.started);
    return cached.response;
  }

  const refresh = startWaterfallRefresh(request, env, deps, template, cacheRequest);
  keepRefreshAlive(deps, refresh.flight, refresh.started);
  const generated = await refresh.flight.generated;
  return generatedWaterfallResponse(request, generated);
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

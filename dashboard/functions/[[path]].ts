import {
  handleHomeRuntime,
  type HomeRuntimeCache,
  type HomeRuntimeEnv,
} from "./home-runtime";
import { renderWaterfall } from "./render-waterfall";
import { maybeProxySeoRequest } from "./seo-proxy";

type PagesContext = Readonly<{
  request: Request;
  env: HomeRuntimeEnv;
  waitUntil(promise: Promise<unknown>): void;
}>;

type EdgeCacheGlobal = Readonly<{
  caches?: Readonly<{ default?: HomeRuntimeCache }>;
}>;

export async function onRequest(context: PagesContext): Promise<Response> {
  const seoResponse = await maybeProxySeoRequest(context.request);
  if (seoResponse) return seoResponse;
  const cache = (globalThis as EdgeCacheGlobal).caches?.default;
  return handleHomeRuntime(context.request, context.env, {
    renderWaterfall,
    cache,
    waitUntil: (promise) => context.waitUntil(promise),
  });
}

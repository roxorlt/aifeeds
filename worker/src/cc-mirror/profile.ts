import type { Env } from "../index";
import { getBases } from "../digest/lib";

export interface ItemPageProfile {
  siteBase: string;
  interactiveBase: string;
  apiBase: string;
  brandName: string;
  titleSuffix: string;
  ccVariant: boolean;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function defaultItemPageProfile(env: Env): ItemPageProfile {
  const { siteBase, apiBase } = getBases(env);
  return {
    siteBase,
    interactiveBase: siteBase,
    apiBase,
    brandName: "AI Feeds",
    titleSuffix: "AI Feeds",
    ccVariant: false,
  };
}

export function ccItemPageProfile(env: Env): ItemPageProfile {
  const defaults = defaultItemPageProfile(env);
  return {
    siteBase: withoutTrailingSlash(
      env.CC_SITE_BASE || "https://ai-feeds.cc",
    ),
    interactiveBase: withoutTrailingSlash(
      defaults.siteBase || "https://ai-feeds.com",
    ),
    apiBase: defaults.apiBase,
    brandName: "AI源信",
    titleSuffix: "AI源信",
    ccVariant: true,
  };
}

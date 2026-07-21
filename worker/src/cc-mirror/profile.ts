import type { Env } from "../index";
import { getBases } from "../digest/lib";

export interface ItemPageProfile {
  siteBase: string;
  interactiveBase: string;
  apiBase: string;
  brandName: string;
  titleSuffix: string;
  ccVariant: boolean;
  archiveBase: string;
  archiveHasSourcePages: boolean;
  defaultOgImage: string;
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
    archiveBase: `${siteBase}/archive`,
    archiveHasSourcePages: true,
    defaultOgImage: `${siteBase}/og-default.png`,
  };
}

export function ccItemPageProfile(env: Env): ItemPageProfile {
  const defaults = defaultItemPageProfile(env);
  const siteBase = withoutTrailingSlash(
    env.CC_SITE_BASE || "https://ai-feeds.cc",
  );
  const interactiveBase = withoutTrailingSlash(
    defaults.siteBase || "https://ai-feeds.com",
  );
  return {
    siteBase,
    interactiveBase,
    apiBase: defaults.apiBase,
    brandName: "AI源信",
    titleSuffix: "AI源信",
    ccVariant: true,
    archiveBase: `${siteBase}/ai-news`,
    archiveHasSourcePages: false,
    defaultOgImage: `${interactiveBase}/og-default.png`,
  };
}

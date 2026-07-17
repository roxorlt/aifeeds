import assert from "node:assert/strict";
import test from "node:test";

import {
  HOME_VIEW_COOKIE,
  HOME_VIEW_MODES,
  isHomeExperienceEnabled,
  isHomeExperiencePath,
  resolveHomeView,
  serializeHomeViewCookie,
} from "./viewMode.ts";

test("home experience is fail-closed unless the exact true value is present", () => {
  for (const value of [undefined, null, "", "false", "TRUE", "1", true]) {
    assert.equal(isHomeExperienceEnabled(value), false);
  }
  assert.equal(isHomeExperienceEnabled("true"), true);
});

test("valid query override wins for one request while an absent query reads the exact cookie token", () => {
  assert.equal(
    resolveHomeView({
      url: new URL("https://ai-feeds.com/?view=waterfall"),
      cookieHeader: `${HOME_VIEW_COOKIE}=classic`,
      enabled: true,
    }),
    "waterfall",
  );
  assert.equal(
    resolveHomeView({
      url: new URL("https://ai-feeds.com/"),
      cookieHeader: `prefix_${HOME_VIEW_COOKIE}=waterfall; ${HOME_VIEW_COOKIE}=classic`,
      enabled: true,
    }),
    "classic",
  );
  assert.equal(
    resolveHomeView({
      url: new URL("https://ai-feeds.com/"),
      cookieHeader: `${HOME_VIEW_COOKIE}=waterfall`,
      enabled: true,
    }),
    "waterfall",
  );
});

test("disabled, malformed, and unknown view values always resolve to classic", () => {
  assert.equal(
    resolveHomeView({
      url: new URL("https://ai-feeds.com/?view=waterfall"),
      cookieHeader: `${HOME_VIEW_COOKIE}=waterfall`,
      enabled: false,
    }),
    "classic",
  );
  for (const value of ["", "new", "WATERFALL", "waterfall<script>"]) {
    assert.equal(
      resolveHomeView({
        url: new URL(`https://ai-feeds.com/?view=${encodeURIComponent(value)}`),
        cookieHeader: `${HOME_VIEW_COOKIE}=waterfall`,
        enabled: true,
      }),
      "classic",
    );
  }
});

test("view cookie serialization is finite and bounded", () => {
  assert.deepEqual(HOME_VIEW_MODES, ["classic", "waterfall"]);
  assert.equal(
    serializeHomeViewCookie("waterfall"),
    "aifeeds_view=waterfall; Path=/; Max-Age=15552000; SameSite=Lax; Secure",
  );
  assert.equal(
    serializeHomeViewCookie("classic"),
    "aifeeds_view=classic; Path=/; Max-Age=15552000; SameSite=Lax; Secure",
  );
  assert.throws(
    () => serializeHomeViewCookie("anything"),
    /invalid home view/i,
  );
});

test("only root and existing drawer deep links belong to the home experience", () => {
  for (const path of [
    "/",
    "/t/123",
    "/g/openai/codex",
    "/ph/tool/2026-07-17",
    "/c/agent",
    "/e/123",
    "/h/2607.12345",
    "/o/blog%3Aopenai%3Aabc",
  ]) {
    assert.equal(isHomeExperiencePath(path), true, path);
  }
  for (const path of [
    "/search",
    "/settings",
    "/feedback",
    "/daily/",
    "/api/items",
    "/assets/app.js",
    "/g/only-owner",
    "/ph/only-slug",
    "/o/",
  ]) {
    assert.equal(isHomeExperiencePath(path), false, path);
  }
});

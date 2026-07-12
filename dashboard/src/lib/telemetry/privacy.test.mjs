import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  classifyReferrer,
  safeApiEndpoint,
  safeAttributionSource,
  sanitizePagePath,
} from "./privacy.ts";

const api = fs.readFileSync(new URL("../../api.ts", import.meta.url), "utf8");
const searchPage = fs.readFileSync(new URL("../../pages/SearchPage.tsx", import.meta.url), "utf8");
const searchGroups = fs.readFileSync(new URL("../../components/search/SearchGroups.tsx", import.meta.url), "utf8");
const searchList = fs.readFileSync(new URL("../../components/search/SearchSourceList.tsx", import.meta.url), "utf8");

test("page paths discard queries, hashes, and dynamic route identifiers", () => {
  assert.equal(sanitizePagePath("/search?q=alice%40example.com&token=secret#private"), "/search");
  assert.equal(sanitizePagePath("/t/private-item-id?from=user"), "/t/:id");
  assert.equal(sanitizePagePath("/g/private-owner/private-repo"), "/g/:owner/:repo");
  assert.equal(sanitizePagePath("/reset/alice@example.com"), "/:other");
  assert.equal(sanitizePagePath("https://ai-feeds.com/settings/account?tab=security"), "/settings/account");
});

test("API errors retain only a bounded endpoint category", () => {
  assert.equal(safeApiEndpoint("/api/items?cursor=private"), "items");
  assert.equal(safeApiEndpoint("/api/items/private-item?token=secret"), "item_detail");
  assert.equal(safeApiEndpoint("/api/auth/verify-code?email=alice@example.com"), "auth");
  assert.equal(safeApiEndpoint("/api/share/permanent/private-token"), "share");
  assert.equal(safeApiEndpoint("https://api.ai-feeds.com/api/unknown/private?q=secret"), "other_api");
  assert.match(api, /endpoint: safeApiEndpoint\(path\)/);
  assert.doesNotMatch(api, /endpoint: path/);
});

test("referrer and campaign attribution are finite categories, never raw values", () => {
  assert.equal(classifyReferrer("", "https://ai-feeds.com"), "direct");
  assert.equal(classifyReferrer("https://ai-feeds.com/search?q=private", "https://ai-feeds.com"), "same_origin");
  assert.equal(classifyReferrer("https://www.google.com/search?q=private", "https://ai-feeds.com"), "search");
  assert.equal(classifyReferrer("https://notgoogle.com/private", "https://ai-feeds.com"), "external");
  assert.equal(classifyReferrer("https://x.com/private-user/status/1", "https://ai-feeds.com"), "social");
  assert.equal(classifyReferrer("https://unknown.example/alice@example.com", "https://ai-feeds.com"), "external");
  assert.equal(safeAttributionSource("NEWSLETTER"), "newsletter");
  assert.equal(safeAttributionSource("alice@example.com"), "other");
  assert.equal(safeAttributionSource(null), undefined);
});

test("search telemetry never persists the submitted query text", () => {
  assert.doesNotMatch(searchPage, /track\(EVENTS\.SEARCH_SUBMIT,[\s\S]{0,120}?\bq:\s*t/);
  assert.doesNotMatch(searchGroups, /track\(EVENTS\.SEARCH_EMPTY,\s*\{\s*q[,}]/);
  assert.doesNotMatch(searchList, /track\(EVENTS\.SEARCH_EMPTY,\s*\{\s*q[,}]/);
  assert.match(searchPage, /q_len:\s*t\.length/);
});

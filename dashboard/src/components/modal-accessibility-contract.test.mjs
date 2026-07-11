import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const drawer = fs.readFileSync(new URL("./TweetDrawer.tsx", import.meta.url), "utf8");
const quote = fs.readFileSync(new URL("./QuoteSnapshotModal.tsx", import.meta.url), "utf8");

test("tweet drawer has a labelled dialog and activates a contained focus session", () => {
  assert.match(drawer, /aria-labelledby="tweet-drawer-title"/);
  assert.match(drawer, /id="tweet-drawer-title"/);
  assert.match(drawer, /activateModalFocus\(aside\)/);
  assert.match(drawer, /data-modal-initial-focus/);
});

test("quote snapshot has a labelled dialog and activates a contained focus session", () => {
  assert.match(quote, /aria-labelledby="quote-snapshot-title"/);
  assert.match(quote, /id="quote-snapshot-title"/);
  assert.match(quote, /activateModalFocus\(panel\)/);
  assert.match(quote, /data-modal-initial-focus/);
});

test("quote original mode follows snapshot identity even when the quote has no id", () => {
  assert.doesNotMatch(quote, /originalForQuoteId|quote\.id \?\? null/);
  assert.match(quote, /originalQuote === quote/);
  assert.match(quote, /setOriginalQuote\(quote\)/);
});

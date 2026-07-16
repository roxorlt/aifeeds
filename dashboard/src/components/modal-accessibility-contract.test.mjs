import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const drawer = fs.readFileSync(new URL("./TweetDrawer.tsx", import.meta.url), "utf8");
const quote = fs.readFileSync(new URL("./QuoteSnapshotModal.tsx", import.meta.url), "utf8");
const modalContracts = [
  ["LoginModal.tsx", "login-modal-title"],
  ["ShareDialog.tsx", "share-dialog-title"],
  ["LogoutConfirm.tsx", "logout-confirm-title"],
  ["DeleteAccountConfirm.tsx", "delete-account-confirm-title"],
  ["AvatarPicker.tsx", "avatar-picker-title"],
];
const modalSources = new Map(modalContracts.map(([filename]) => [
  filename,
  fs.readFileSync(new URL(`./${filename}`, import.meta.url), "utf8"),
]));
const lightbox = fs.readFileSync(new URL("./Lightbox.tsx", import.meta.url), "utf8");
const userMenu = fs.readFileSync(new URL("./UserMenu.tsx", import.meta.url), "utf8");

const pageLockingModals = [
  ["QuoteSnapshotModal.tsx", quote],
  ...[...modalSources.entries()],
];

test("tweet drawer has a labelled dialog and delegates Escape to its focus session", () => {
  assert.match(drawer, /aria-labelledby="tweet-drawer-title"/);
  assert.match(drawer, /id="tweet-drawer-title"/);
  assert.match(drawer, /activateModalFocus\(aside,\s*\{[\s\S]*?onEscape:/);
  assert.match(drawer, /data-modal-initial-focus/);
  assert.doesNotMatch(drawer, /window\.addEventListener\("keydown"/);
});

test("quote snapshot has a labelled dialog and delegates Escape to its focus session", () => {
  assert.match(quote, /aria-labelledby="quote-snapshot-title"/);
  assert.match(quote, /id="quote-snapshot-title"/);
  assert.match(quote, /activateModalFocus\(panel,\s*\{[\s\S]*?onEscape:/);
  assert.match(quote, /data-modal-initial-focus/);
  assert.doesNotMatch(quote, /window\.addEventListener\("keydown"/);
});

test("quote original mode follows snapshot identity even when the quote has no id", () => {
  assert.doesNotMatch(quote, /originalForQuoteId|quote\.id \?\? null/);
  assert.match(quote, /originalQuote === quote/);
  assert.match(quote, /setOriginalQuote\(quote\)/);
});

for (const [filename, titleId] of modalContracts) {
  test(`${filename} exposes one labelled dialog and activates its visible panel`, () => {
    const source = modalSources.get(filename);
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, new RegExp(`aria-labelledby="${titleId}"`));
    assert.match(source, new RegExp(`id="${titleId}"`));
    assert.match(source, /activateModalFocus\([^,]+,\s*\{[\s\S]*?onEscape:/);
    assert.match(source, /data-modal-initial-focus/);
    assert.match(source, /tabIndex=\{-1\}/);
  });
}

for (const [filename, source] of pageLockingModals) {
  test(`${filename} locks the responsive page scroller while visible`, () => {
    assert.match(source, /import \{ useScrollLock \} from ['"]\.\.\/lib\/useScrollLock['"];?/);
    assert.match(source, /useScrollLock\((?:modalOpen|open)\);/);
  });
}

test("quote snapshot does not fall back to a body-only scroll lock", () => {
  assert.doesNotMatch(quote, /document\.body\.style\.overflow/);
});

test("login and account deletion let the focus session capture the real trigger", () => {
  assert.doesNotMatch(modalSources.get("LoginModal.tsx"), /autoFocus/);
  assert.doesNotMatch(modalSources.get("DeleteAccountConfirm.tsx"), /autoFocus/);
});

test("lightbox delegates Escape to the focus session while keeping arrow navigation", () => {
  assert.match(lightbox, /role="dialog"/);
  assert.match(lightbox, /aria-modal="true"/);
  assert.match(lightbox, /aria-label="媒体预览"/);
  assert.match(lightbox, /activateModalFocus\([^,]+,\s*\{[\s\S]*?onEscape:/);
  assert.match(lightbox, /data-modal-initial-focus/);
  assert.match(lightbox, /tabIndex=\{-1\}/);
  assert.doesNotMatch(lightbox, /e\.key === "Escape"/);
  assert.match(lightbox, /e\.key === "ArrowLeft"/);
  assert.match(lightbox, /e\.key === "ArrowRight"/);
});

test("guest login focuses the persistent account trigger before closing its menu", () => {
  assert.equal((userMenu.match(/ref=\{accountTriggerRef\}/g) ?? []).length, 2);
  assert.match(
    userMenu,
    /focusModalTrigger\(accountTriggerRef\.current\);\s*requestClose\(\);\s*openLogin\("manual"\);/,
  );
});

for (const filename of ["LogoutConfirm.tsx", "DeleteAccountConfirm.tsx"]) {
  test(`${filename} keeps Escape owned but blocks dismissal during its request`, () => {
    const source = modalSources.get(filename);
    assert.match(source, /const dismissAllowedRef = useRef\(true\);/);
    assert.match(
      source,
      /onEscape:\s*\(\) => \{\s*if \(dismissAllowedRef\.current\) escapeCloseRef\.current\(\);\s*\}/,
    );
    assert.match(
      source,
      /dismissAllowedRef\.current = false;\s*setLoading\(true\);[\s\S]*?finally \{\s*dismissAllowedRef\.current = true;\s*setLoading\(false\);/,
    );
    assert.match(source, /disabled=\{loading\}/);
  });
}

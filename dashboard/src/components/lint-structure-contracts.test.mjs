import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), "utf8");
const readOptional = (relativePath) => {
  try {
    return read(relativePath);
  } catch {
    return "";
  }
};

test("the Huodongxing secondary-city expansion is derived without an effect state write", () => {
  const source = read("components/HuodongxingColumnHeader.tsx");

  assert.doesNotMatch(source, /if \(isSecondary\) setShowMore\(true\)/);
  assert.match(source, /const citiesExpanded = showMore \|\| isSecondary/);
});

test("long-lived callbacks delegate to tested lifecycle bridges without render-time ref writes", () => {
  const turnstile = read("components/TurnstileWidget.tsx");
  const impressionRefresh = read("lib/impressionRefresh.ts");

  assert.doesNotMatch(turnstile, /cbRef/);
  assert.match(turnstile, /createTurnstileCallbackBridge/);
  assert.match(
    turnstile,
    /useLayoutEffect\(\(\) => \{\s*callbackBridge\.update\(\{ onToken, onError, onExpire \}\);\s*\}, \[callbackBridge, onToken, onError, onExpire\]\)/,
  );
  assert.doesNotMatch(impressionRefresh, /itemIdRef/);
  assert.match(impressionRefresh, /updateObservedImpressionElement/);
  assert.match(
    impressionRefresh,
    /return useCallback\(\s*\(node\) => updateImpressionElement\(node, itemId, elRef\),\s*\[itemId\],\s*\);/,
  );
});

test("component modules keep only component runtime exports for Fast Refresh", () => {
  const posterCanvas = read("components/PosterCanvas.tsx");
  const posterCapture = readOptional("lib/posterCapture.ts");
  const tcoCard = read("components/TcoResolvedLinkCard.tsx");
  const tcoModel = readOptional("lib/tcoResolvedLink.ts");
  const xArticleCard = read("components/XArticleCard.tsx");
  const xArticleModel = readOptional("lib/xArticleTier.ts");
  const videoProvider = read("lib/videoColumnContext.tsx");
  const videoState = readOptional("lib/videoColumn.ts");
  const githubDrawer = read("components/GithubDrawerBody.tsx");
  const githubReadme = readOptional("lib/githubReadme.ts");
  const drawerProvider = read("lib/drawer.tsx");
  const drawerContext = readOptional("lib/drawerContext.ts");

  assert.doesNotMatch(posterCanvas, /export async function capturePosterFromRef/);
  assert.match(posterCapture, /export async function capturePosterFromRef/);

  assert.doesNotMatch(tcoCard, /export function isTcoOnly/);
  assert.match(tcoModel, /export function isTcoOnly/);

  assert.doesNotMatch(xArticleCard, /export function articleTier/);
  assert.match(xArticleModel, /export function articleTier/);

  assert.doesNotMatch(videoProvider, /export function useVideoColumn/);
  assert.match(videoState, /export function useVideoColumn/);

  assert.doesNotMatch(githubDrawer, /export function extractReadmeImages/);
  assert.match(githubReadme, /export function extractReadmeImages/);

  assert.doesNotMatch(drawerProvider, /export function useDrawer/);
  assert.match(drawerContext, /export function useDrawer/);
});

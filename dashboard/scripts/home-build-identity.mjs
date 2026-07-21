import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const HOME_BUILD_ID_PLACEHOLDER = "__AIFEEDS_HOME_BUILD_IDENTITY__";

const META_PATTERN =
  /(<meta\s+name=["']aifeeds-build-id["']\s+content=["'])([^"']+)(["'][^>]*>)/giu;

async function artifactFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await artifactFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      throw new Error(`unsupported artifact entry: ${path.relative(root, absolute)}`);
    }
  }
  return files.sort();
}

function waterfallIdentity(html) {
  const matches = [...html.matchAll(META_PATTERN)];
  if (matches.length !== 1) {
    throw new Error(`expected one waterfall build identity slot, received ${matches.length}`);
  }
  return matches[0][2];
}

function normalizedWaterfallHtml(html) {
  waterfallIdentity(html);
  return html.replace(
    META_PATTERN,
    `$1${HOME_BUILD_ID_PLACEHOLDER}$3`,
  );
}

export async function computeHomeBuildIdentity(distDirectory) {
  const files = await artifactFiles(distDirectory);
  if (!files.includes("waterfall.html")) {
    throw new Error("waterfall.html is missing from the build artifact");
  }

  const hash = createHash("sha256");
  hash.update("aifeeds-home-artifact-v1\0");
  for (const relative of files) {
    const absolute = path.join(distDirectory, ...relative.split("/"));
    let contents = await readFile(absolute);
    if (relative === "waterfall.html") {
      contents = Buffer.from(normalizedWaterfallHtml(contents.toString("utf8")));
    }
    hash.update(`${Buffer.byteLength(relative)}:${relative}:${contents.byteLength}:`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function stampHomeBuildIdentity(distDirectory) {
  const htmlPath = path.join(distDirectory, "waterfall.html");
  const html = await readFile(htmlPath, "utf8");
  const currentIdentity = waterfallIdentity(html);
  if (currentIdentity !== HOME_BUILD_ID_PLACEHOLDER) {
    throw new Error("waterfall build identity slot was already stamped or corrupted");
  }

  const identity = await computeHomeBuildIdentity(distDirectory);
  await writeFile(
    htmlPath,
    html.replace(META_PATTERN, `$1${identity}$3`),
  );
  return identity;
}

export async function verifyHomeBuildIdentity(distDirectory) {
  const html = await readFile(path.join(distDirectory, "waterfall.html"), "utf8");
  const actual = waterfallIdentity(html);
  if (!/^[a-f0-9]{64}$/.test(actual)) {
    throw new Error("waterfall build identity is not a finite SHA-256 value");
  }
  if (html.includes(HOME_BUILD_ID_PLACEHOLDER)) {
    throw new Error("waterfall build identity placeholder escaped artifact stamping");
  }

  const expected = await computeHomeBuildIdentity(distDirectory);
  if (actual !== expected) {
    throw new Error("waterfall build identity does not match artifact graph");
  }
  return actual;
}

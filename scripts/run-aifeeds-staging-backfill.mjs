#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const STAGING_ENDPOINT = "https://staging-api.ai-feeds.com/api/enrich/run";
const DEFAULT_MAX_BATCHES = 20;
export const MAX_BATCHES = 100;

const MODE_CONFIG = Object.freeze({
  "github-cover-backfill": Object.freeze({
    defaultLimit: 100,
    maxLimit: 500,
    batchCounter: "candidates",
    counters: Object.freeze([
      "candidates",
      "covers",
      "none",
      "would_update",
      "updated",
      "conflicts",
      "errors",
      "remaining",
    ]),
  }),
  "card-image-variant-backfill": Object.freeze({
    defaultLimit: 10,
    maxLimit: 25,
    batchCounter: "picked",
    counters: Object.freeze([
      "picked",
      "resolvable",
      "would_update",
      "updated",
      "source_unavailable",
      "transform_failed",
      "conflicts",
      "errors",
      "remaining",
    ]),
  }),
});

class BackfillRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackfillRunError";
    this.code = code;
  }
}

function integerArg(value, name, min, max) {
  if (!/^\d+$/.test(value || "")) {
    throw new BackfillRunError(
      "invalid_arguments",
      `${name} must be an integer in ${min}..${max}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BackfillRunError(
      "invalid_arguments",
      `${name} must be an integer in ${min}..${max}`,
    );
  }
  return parsed;
}

function safeCursor(value) {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BackfillRunError("invalid_arguments", "--after-id is invalid");
  }
  return value;
}

export function parseArgs(args) {
  let mode;
  let write = false;
  let requestedLimit;
  let maxBatches = DEFAULT_MAX_BATCHES;
  let afterId = "";
  const seen = new Set();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!new Set(["--mode", "--write", "--limit", "--max-batches", "--after-id"]).has(arg)) {
      throw new BackfillRunError("invalid_arguments", "unknown argument");
    }
    if (seen.has(arg)) {
      throw new BackfillRunError("invalid_arguments", "duplicate argument");
    }
    seen.add(arg);

    if (arg === "--write") {
      write = true;
      continue;
    }

    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new BackfillRunError("invalid_arguments", `missing value for ${arg}`);
    }
    if (arg === "--mode") mode = value;
    else if (arg === "--limit") requestedLimit = value;
    else if (arg === "--max-batches") {
      maxBatches = integerArg(value, "--max-batches", 1, MAX_BATCHES);
    } else if (arg === "--after-id") afterId = safeCursor(value);
  }

  const config = MODE_CONFIG[mode];
  if (!config) {
    throw new BackfillRunError("invalid_arguments", "unsupported --mode");
  }
  const limit = requestedLimit === undefined
    ? config.defaultLimit
    : integerArg(requestedLimit, "--limit", 1, config.maxLimit);

  return { mode, write, limit, maxBatches, afterId };
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function responseContractError() {
  return new BackfillRunError("response_contract", "staging response contract mismatch");
}

function assertCounter(payload, field) {
  const value = payload[field];
  if (!Number.isSafeInteger(value) || value < 0) throw responseContractError();
}

function validateResponse(payload, mode, dryRun, limit) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw responseContractError();
  }
  const config = MODE_CONFIG[mode];
  for (const field of config.counters) assertCounter(payload, field);
  if (payload[config.batchCounter] > limit) throw responseContractError();
  if (payload.dry_run !== dryRun || typeof payload.complete !== "boolean") {
    throw responseContractError();
  }
  if (
    payload.next_cursor !== null
    && (
      typeof payload.next_cursor !== "string"
      || payload.next_cursor.length === 0
      || payload.next_cursor.length > 512
      || /[\u0000-\u001f\u007f]/.test(payload.next_cursor)
    )
  ) {
    throw responseContractError();
  }
  if (payload.complete && (payload.remaining !== 0 || payload.next_cursor !== null)) {
    throw responseContractError();
  }
  if (payload.updated > payload.would_update || (dryRun && payload.updated !== 0)) {
    throw responseContractError();
  }
  return payload;
}

function batchEvidence(payload, { mode, dryRun, batch, cursor, timestamp }) {
  const evidence = {
    event: "backfill_batch",
    timestamp,
    mode,
    dry_run: dryRun,
    batch,
    cursor: cursor || null,
    next_cursor: payload.next_cursor,
    complete: payload.complete,
  };
  for (const field of MODE_CONFIG[mode].counters) evidence[field] = payload[field];
  return evidence;
}

function finishedEvidence({ mode, dryRun, batches, status, payload, nextCursor, timestamp }) {
  return {
    event: "backfill_finished",
    timestamp,
    mode,
    dry_run: dryRun,
    batches,
    status,
    remaining: payload.remaining,
    next_cursor: nextCursor,
  };
}

export async function runBackfill(options, deps = {}) {
  const config = MODE_CONFIG[options.mode];
  if (!config) throw new BackfillRunError("invalid_arguments", "unsupported --mode");
  integerArg(String(options.limit), "--limit", 1, config.maxLimit);
  integerArg(String(options.maxBatches), "--max-batches", 1, MAX_BATCHES);
  const initialCursor = safeCursor(options.afterId || "");
  if (typeof options.token !== "string" || options.token.length === 0) {
    throw new BackfillRunError("missing_token", "INGEST_TOKEN is required");
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const stdout = deps.stdout ?? process.stdout;
  const now = deps.now ?? (() => new Date().toISOString());
  const dryRun = options.write !== true;
  let cursor = initialCursor;
  const visited = new Set(cursor ? [cursor] : []);

  for (let batch = 1; batch <= options.maxBatches; batch++) {
    const url = new URL(STAGING_ENDPOINT);
    url.searchParams.set("mode", options.mode);
    url.searchParams.set("dry_run", dryRun ? "1" : "0");
    url.searchParams.set("limit", String(options.limit));
    if (cursor) url.searchParams.set("after_id", cursor);

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${options.token}`,
      "User-Agent": "aifeeds-staging-backfill/1.0",
    };
    if (typeof options.devToken === "string" && options.devToken.length > 0) {
      headers["X-Dev-Token"] = options.devToken;
    }

    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new BackfillRunError("network_error", "staging backfill request failed");
    }
    if (!response || !response.ok) {
      const status = Number.isInteger(response?.status) ? response.status : 0;
      throw new BackfillRunError("http_error", `staging backfill HTTP ${status}`);
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new BackfillRunError("non_json_response", "staging response was not JSON");
    }
    validateResponse(payload, options.mode, dryRun, options.limit);
    writeJsonLine(stdout, batchEvidence(payload, {
      mode: options.mode,
      dryRun,
      batch,
      cursor,
      timestamp: now(),
    }));

    if (payload.errors > 0) {
      throw new BackfillRunError("server_errors", "staging backfill reported errors");
    }
    if (payload.conflicts > 0) {
      throw new BackfillRunError("server_conflicts", "staging backfill reported conflicts");
    }
    if (payload.complete) {
      const finished = finishedEvidence({
        mode: options.mode,
        dryRun,
        batches: batch,
        status: "complete",
        payload,
        nextCursor: null,
        timestamp: now(),
      });
      writeJsonLine(stdout, finished);
      return finished;
    }

    const nextCursor = payload.next_cursor;
    if (nextCursor === null) {
      if (!dryRun) {
        throw new BackfillRunError(
          "incomplete_write",
          "write backfill stopped before completion",
        );
      }
      if (payload[config.batchCounter] >= options.limit) {
        throw responseContractError();
      }
      const finished = finishedEvidence({
        mode: options.mode,
        dryRun,
        batches: batch,
        status: "inventory_complete",
        payload,
        nextCursor: null,
        timestamp: now(),
      });
      writeJsonLine(stdout, finished);
      return finished;
    }
    if ((cursor && nextCursor <= cursor) || visited.has(nextCursor)) {
      throw new BackfillRunError(
        "cursor_not_progressing",
        "staging backfill cursor did not progress",
      );
    }
    visited.add(nextCursor);

    if (batch === options.maxBatches) {
      const finished = finishedEvidence({
        mode: options.mode,
        dryRun,
        batches: batch,
        status: "bounded_pause",
        payload,
        nextCursor,
        timestamp: now(),
      });
      writeJsonLine(stdout, finished);
      return finished;
    }
    cursor = nextCursor;
  }

  throw new BackfillRunError("response_contract", "unreachable batch state");
}

export async function runCli(args, deps = {}) {
  const env = deps.env ?? process.env;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    const options = parseArgs(args);
    const token = typeof env.INGEST_TOKEN === "string" ? env.INGEST_TOKEN : "";
    const devToken = typeof env.DEV_TOKEN === "string" ? env.DEV_TOKEN : "";
    await runBackfill(
      { ...options, token, devToken },
      { ...deps, now },
    );
    return 0;
  } catch (error) {
    const safeError = error instanceof BackfillRunError
      ? error
      : new BackfillRunError("unexpected_error", "staging backfill runner failed");
    writeJsonLine(stderr, {
      event: "backfill_error",
      timestamp: now(),
      code: safeError.code,
      message: safeError.message,
    });
    return 1;
  }
}

async function main() {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BATCHES,
  parseArgs,
  runCli,
} from "./run-aifeeds-staging-backfill.mjs";

const SECRET = "ingest-secret-must-never-be-logged";
const DEV_SECRET = "dev-secret-must-never-be-logged";

function githubPayload(overrides = {}) {
  return {
    dry_run: true,
    candidates: 1,
    covers: 1,
    none: 0,
    would_update: 1,
    updated: 0,
    conflicts: 0,
    errors: 0,
    remaining: 1,
    complete: false,
    next_cursor: null,
    ...overrides,
  };
}

function cardPayload(overrides = {}) {
  return {
    dry_run: true,
    picked: 1,
    resolvable: 1,
    would_update: 1,
    updated: 0,
    source_unavailable: 0,
    transform_failed: 0,
    conflicts: 0,
    errors: 0,
    remaining: 1,
    complete: false,
    next_cursor: null,
    ...overrides,
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    deps: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
    },
  };
}

function records(chunks) {
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("CLI defaults both exact modes to dry-run and bounded batches", () => {
  assert.deepEqual(parseArgs(["--mode", "github-cover-backfill"]), {
    mode: "github-cover-backfill",
    write: false,
    limit: 100,
    maxBatches: 20,
    afterId: "",
  });
  assert.deepEqual(parseArgs(["--mode", "card-image-variant-backfill"]), {
    mode: "card-image-variant-backfill",
    write: false,
    limit: 10,
    maxBatches: 20,
    afterId: "",
  });
});

test("CLI rejects unsupported modes, target overrides, and values above hard caps", () => {
  assert.equal(MAX_BATCHES, 100);
  assert.throws(
    () => parseArgs(["--mode", "blog-cover-og-backfill"]),
    /unsupported --mode/,
  );
  assert.throws(
    () => parseArgs(["--mode", "github-cover-backfill", "--url", "https:\/\/example.com"]),
    /unknown argument/,
  );
  assert.throws(
    () => parseArgs(["--mode", "github-cover-backfill", "--max-batches", "101"]),
    /--max-batches must be an integer in 1\.\.100/,
  );
  assert.throws(
    () => parseArgs(["--mode", "card-image-variant-backfill", "--limit", "26"]),
    /--limit must be an integer in 1\.\.25/,
  );
});

test("dry-run follows a progressing cursor on the fixed staging endpoint and logs allowlisted JSONL", async () => {
  const calls = [];
  const io = createIo();
  const payloads = [
    githubPayload({ next_cursor: "github:octo/one" }),
    githubPayload({
      candidates: 0,
      covers: 0,
      would_update: 0,
      remaining: 1,
    }),
  ];
  const fetchImpl = async (input, init) => {
    calls.push({ url: new URL(input), init });
    return jsonResponse(payloads.shift());
  };

  const code = await runCli(
    ["--mode", "github-cover-backfill", "--max-batches", "2"],
    {
      ...io.deps,
      env: { INGEST_TOKEN: SECRET, DEV_TOKEN: DEV_SECRET },
      fetchImpl,
      now: () => "2026-07-12T08:00:00.000Z",
    },
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.origin, "https://staging-api.ai-feeds.com");
    assert.equal(call.url.pathname, "/api/enrich/run");
    assert.equal(call.url.searchParams.get("mode"), "github-cover-backfill");
    assert.equal(call.url.searchParams.get("dry_run"), "1");
    assert.equal(call.init.method, "POST");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${SECRET}`);
    assert.equal(headers.get("X-Dev-Token"), DEV_SECRET);
  }
  assert.equal(calls[0].url.searchParams.has("after_id"), false);
  assert.equal(calls[1].url.searchParams.get("after_id"), "github:octo/one");

  const output = io.stdout.join("");
  assert.equal(output.includes(SECRET), false);
  assert.equal(output.includes(DEV_SECRET), false);
  assert.deepEqual(records(io.stdout).map((row) => row.event), [
    "backfill_batch",
    "backfill_batch",
    "backfill_finished",
  ]);
  assert.equal(records(io.stdout).at(-1).status, "inventory_complete");
  assert.equal(io.stderr.length, 0);
});

test("only --write changes the request to dry_run=0", async () => {
  const io = createIo();
  let requestUrl;
  const code = await runCli(
    ["--mode", "card-image-variant-backfill", "--write"],
    {
      ...io.deps,
      env: { INGEST_TOKEN: SECRET },
      fetchImpl: async (input) => {
        requestUrl = new URL(input);
        return jsonResponse(cardPayload({
          dry_run: false,
          updated: 1,
          remaining: 0,
          complete: true,
        }));
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(requestUrl.searchParams.get("dry_run"), "0");
  assert.equal(records(io.stdout).at(-1).dry_run, false);
});

test("max-batches is a successful bounded pause with a resumable cursor", async () => {
  const io = createIo();
  let calls = 0;
  const code = await runCli(
    ["--mode", "github-cover-backfill", "--max-batches", "1"],
    {
      ...io.deps,
      env: { INGEST_TOKEN: SECRET },
      fetchImpl: async () => {
        calls++;
        return jsonResponse(githubPayload({ next_cursor: "github:octo/resume" }));
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(calls, 1);
  const finished = records(io.stdout).at(-1);
  assert.equal(finished.event, "backfill_finished");
  assert.equal(finished.status, "bounded_pause");
  assert.equal(finished.next_cursor, "github:octo/resume");
});

test("HTTP and non-JSON failures stop nonzero without echoing response bodies or tokens", async (t) => {
  const cases = [
    {
      name: "http",
      response: new Response(`upstream leaked ${SECRET}`, { status: 503 }),
      code: "http_error",
    },
    {
      name: "non-json",
      response: new Response(`not-json ${SECRET}`, { status: 200 }),
      code: "non_json_response",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const io = createIo();
      const exitCode = await runCli(["--mode", "github-cover-backfill"], {
        ...io.deps,
        env: { INGEST_TOKEN: SECRET },
        fetchImpl: async () => item.response,
      });

      assert.equal(exitCode, 1);
      assert.equal(io.stdout.length, 0);
      assert.equal(io.stderr.join("").includes(SECRET), false);
      assert.equal(records(io.stderr)[0].code, item.code);
    });
  }
});

test("server errors and conflicts emit the safe batch evidence then stop nonzero", async (t) => {
  for (const [field, code] of [["errors", "server_errors"], ["conflicts", "server_conflicts"]]) {
    await t.test(field, async () => {
      const io = createIo();
      const exitCode = await runCli(["--mode", "github-cover-backfill"], {
        ...io.deps,
        env: { INGEST_TOKEN: SECRET },
        fetchImpl: async () => jsonResponse(githubPayload({ [field]: 1 })),
      });

      assert.equal(exitCode, 1);
      assert.equal(records(io.stdout)[0][field], 1);
      assert.equal(records(io.stderr)[0].code, code);
    });
  }
});

test("a stalled or regressing cursor stops nonzero", async (t) => {
  for (const nextCursor of ["github:octo/same", "github:octo/before"]) {
    await t.test(nextCursor, async () => {
      const io = createIo();
      const exitCode = await runCli([
        "--mode", "github-cover-backfill",
        "--after-id", "github:octo/same",
      ], {
        ...io.deps,
        env: { INGEST_TOKEN: SECRET },
        fetchImpl: async () => jsonResponse(githubPayload({ next_cursor: nextCursor })),
      });

      assert.equal(exitCode, 1);
      assert.equal(records(io.stderr)[0].code, "cursor_not_progressing");
    });
  }
});

test("response contract anomalies and incomplete write responses stop nonzero", async (t) => {
  const malformed = githubPayload();
  delete malformed.remaining;
  const cases = [
    ["missing field", malformed],
    ["wrong dry mode", githubPayload({ dry_run: false })],
    ["complete with work remaining", githubPayload({ complete: true })],
  ];

  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      const io = createIo();
      const exitCode = await runCli(["--mode", "github-cover-backfill"], {
        ...io.deps,
        env: { INGEST_TOKEN: SECRET },
        fetchImpl: async () => jsonResponse(payload),
      });
      assert.equal(exitCode, 1);
      assert.equal(records(io.stderr)[0].code, "response_contract");
    });
  }

  await t.test("dry-run full batch cannot terminate without a cursor", async () => {
    const io = createIo();
    const exitCode = await runCli([
      "--mode", "github-cover-backfill",
      "--limit", "1",
    ], {
      ...io.deps,
      env: { INGEST_TOKEN: SECRET },
      fetchImpl: async () => jsonResponse(githubPayload({ candidates: 1 })),
    });
    assert.equal(exitCode, 1);
    assert.equal(records(io.stderr)[0].code, "response_contract");
  });

  await t.test("write lane cannot silently stop incomplete", async () => {
    const io = createIo();
    const exitCode = await runCli(["--mode", "card-image-variant-backfill", "--write"], {
      ...io.deps,
      env: { INGEST_TOKEN: SECRET },
      fetchImpl: async () => jsonResponse(cardPayload({ dry_run: false })),
    });
    assert.equal(exitCode, 1);
    assert.equal(records(io.stderr)[0].code, "incomplete_write");
  });
});

test("missing ingest credentials fail before any request", async () => {
  const io = createIo();
  let calls = 0;
  const exitCode = await runCli(["--mode", "github-cover-backfill"], {
    ...io.deps,
    env: {},
    fetchImpl: async () => {
      calls++;
      throw new Error("must not run");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(calls, 0);
  assert.equal(records(io.stderr)[0].code, "missing_token");
});

test("invalid positional input is never reflected into error JSONL", async () => {
  const io = createIo();
  const exitCode = await runCli([SECRET], {
    ...io.deps,
    env: { INGEST_TOKEN: SECRET },
  });

  assert.equal(exitCode, 1);
  assert.equal(io.stderr.join("").includes(SECRET), false);
  assert.equal(records(io.stderr)[0].code, "invalid_arguments");
});

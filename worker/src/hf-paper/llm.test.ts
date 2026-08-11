import { afterEach, describe, expect, it, vi } from "vitest";
import { callDeepSeek, callDeepSeekJson } from "./llm";

function okResponse(content = '{"ok":true}'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function diagnosticResponse(input: {
  content?: string | null;
  reasoning?: string;
  finish?: string;
  usage?: Record<string, unknown>;
  choices?: unknown[];
}): Response {
  return new Response(JSON.stringify({
    choices: input.choices ?? [{
      message: {
        content: input.content ?? null,
        reasoning_content: input.reasoning,
      },
      finish_reason: input.finish,
    }],
    usage: input.usage,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as unknown as Array<
    [unknown, RequestInit?]
  >;
  return JSON.parse(String(calls[0]?.[1]?.body)) as {
    messages: Array<{ role: string; content: string }>;
    response_format?: { type: string };
    max_tokens: number;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeepSeek message roles", () => {
  it("keeps the existing single-user-message request when systemPrompt is absent", async () => {
    const fetchMock = vi.fn(async () => okResponse("plain result"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callDeepSeek("test-key", "test-model", "legacy user prompt", {
      timeoutMs: 1_000,
    });

    expect(result.text).toBe("plain result");
    expect(requestBody(fetchMock).max_tokens).toBe(4096);
    expect(requestBody(fetchMock).messages).toEqual([
      { role: "user", content: "legacy user prompt" },
    ]);
  });

  it("adds a system message before the separate user data for JSON calls", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await callDeepSeekJson<{ ok: boolean }>(
      "test-key",
      "test-model",
      "untrusted user data",
      {
        retries: 0,
        timeoutMs: 1_000,
        systemPrompt: "trusted classification rules",
      },
    );

    expect(result.data).toEqual({ ok: true });
    expect(requestBody(fetchMock)).toMatchObject({
      messages: [
        { role: "system", content: "trusted classification rules" },
        { role: "user", content: "untrusted user data" },
      ],
      response_format: { type: "json_object" },
    });
  });

  it("logs only parse metadata and never raw model output", async () => {
    const sentinel = "RAW-SENTINEL-DO-NOT-LOG";
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(`{broken:${sentinel}`)));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await callDeepSeekJson("test-key", "test-model", "prompt", {
      retries: 0, timeoutMs: 1_000, requestId: "request-123",
    });

    expect(result).toMatchObject({ data: null, error: "json_parse_fail" });
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(sentinel);
    expect(logged).toContain("model=test-model");
    expect(logged).toContain("request=request-123");
    expect(logged).toMatch(/length=\d+/);
    expect(logged).toMatch(/sha256=[a-f0-9]{64}/);
  });

  it("does not log an HTTP provider response body", async () => {
    vi.useFakeTimers();
    const sentinel = "PROVIDER-RESPONSE-DO-NOT-LOG";
    let signal: AbortSignal | undefined;
    const readBody = vi.fn(async () => new Promise<string>(() => undefined));
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      signal = init?.signal || undefined;
      return { ok: false, status: 503, text: readBody } as unknown as Response;
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await callDeepSeekJson("test-key", "test-model", "prompt", {
      retries: 0, timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ data: null, error: "HTTP 503" });
    expect(readBody).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(signal?.aborted).toBe(false);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(sentinel);
  });

  it("keeps the timeout active until a successful response body is fully consumed", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const parseBody = vi.fn(async () => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("body read aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      signal = init?.signal || undefined;
      return { ok: true, status: 200, json: parseBody } as unknown as Response;
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = callDeepSeek("test-key", "test-model", "prompt", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(pending).resolves.toMatchObject({ text: null, error: "AbortError" });
    expect(parseBody).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows one provider response after 120 seconds when the caller grants a 210-second budget", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(okResponse()), 130_000);
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = callDeepSeekJson<{ ok: boolean }>("test-key", "test-model", "prompt", {
      retries: 0, timeoutMs: 210_000,
    });
    await vi.advanceTimersByTimeAsync(130_000);

    await expect(pending).resolves.toMatchObject({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps safe length diagnostics when reasoning exhausts the budget without final content", async () => {
    const reasoningSentinel = `PRIVATE-REASONING-${"r".repeat(3_500)}`;
    vi.stubGlobal("fetch", vi.fn(async () => diagnosticResponse({
      content: null,
      reasoning: reasoningSentinel,
      finish: "length",
      usage: {
        prompt_tokens: 1_200,
        completion_tokens: 3_500,
        total_tokens: 4_700,
        reasoning_tokens: 3_500,
      },
    })));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await callDeepSeekJson("test-key", "test-model", "prompt", { retries: 0 });

    expect(result).toMatchObject({
      data: null,
      error: "no_text",
      diagnostics: {
        finish_reason: "length",
        content_chars: 0,
        reasoning_chars: reasoningSentinel.length,
        usage: {
          prompt_tokens: 1_200,
          completion_tokens: 3_500,
          total_tokens: 4_700,
          reasoning_tokens: 3_500,
        },
      },
    });
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(reasoningSentinel);
  });

  it.each([
    ["length", "json_parse_fail"],
    ["insufficient_system_resource", "json_parse_fail"],
  ])("rejects partial JSON when the trusted finish reason is %s", async (finish, error) => {
    vi.stubGlobal("fetch", vi.fn(async () => diagnosticResponse({
      content: '{"ok":', reasoning: "PRIVATE-PARTIAL-COT", finish,
    })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await callDeepSeekJson<{ ok: boolean }>(
      "test-key", "test-model", "prompt", { retries: 0 },
    );

    expect(result).toMatchObject({
      data: null,
      error,
      diagnostics: { finish_reason: finish, content_chars: 6 },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-PARTIAL-COT");
  });

  it.each(["length", "insufficient_system_resource"])(
    "fails closed on valid JSON when the trusted finish reason is %s",
    async (finish) => {
      vi.stubGlobal("fetch", vi.fn(async () => diagnosticResponse({
        content: '{"ok":true}', reasoning: "PRIVATE-VALID-BUT-INCOMPLETE-COT", finish,
      })));

      const result = await callDeepSeekJson<{ ok: boolean }>(
        "test-key", "test-model", "prompt", { retries: 0 },
      );

      expect(result).toMatchObject({
        data: null,
        error: "no_text",
        diagnostics: { finish_reason: finish, content_chars: 11 },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE-VALID-BUT-INCOMPLETE-COT");
    },
  );

  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["insufficient_system_resource", "insufficient_system_resource"],
    ["future_provider_reason", "unknown"],
  ])("normalizes an empty %s finish reason without exposing content", async (finish, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => diagnosticResponse({
      content: "   ", reasoning: "PRIVATE-COT", finish,
    })));

    const result = await callDeepSeekJson("test-key", "test-model", "prompt", { retries: 0 });

    expect(result).toMatchObject({
      data: null, error: "no_text",
      diagnostics: { finish_reason: expected, content_chars: 3, reasoning_chars: 11 },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-COT");
  });

  it("normalizes a missing choice to bounded no-text diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => diagnosticResponse({ choices: [] })));

    const result = await callDeepSeekJson("test-key", "test-model", "prompt", { retries: 0 });

    expect(result).toMatchObject({
      data: null, error: "no_text",
      diagnostics: {
        finish_reason: "unknown", content_chars: 0, reasoning_chars: 0, usage: {},
      },
    });
  });

  it("returns valid JSON with nested reasoning-token usage and only safe diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => diagnosticResponse({
      content: '{"ok":true}', reasoning: "PRIVATE-VALID-COT", finish: "stop",
      usage: {
        prompt_tokens: 20,
        completion_tokens: 30,
        total_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 17 },
      },
    })));

    const result = await callDeepSeekJson<{ ok: boolean }>(
      "test-key", "test-model", "prompt", { retries: 0 },
    );

    expect(result).toEqual({
      data: { ok: true },
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, reasoning_tokens: 17 },
      diagnostics: {
        finish_reason: "stop",
        content_chars: 11,
        reasoning_chars: 17,
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, reasoning_tokens: 17 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-VALID-COT");
  });
});

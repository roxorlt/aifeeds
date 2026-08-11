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

function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as unknown as Array<
    [unknown, RequestInit?]
  >;
  return JSON.parse(String(calls[0]?.[1]?.body)) as {
    messages: Array<{ role: string; content: string }>;
    response_format?: { type: string };
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
});

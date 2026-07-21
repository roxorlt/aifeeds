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
});

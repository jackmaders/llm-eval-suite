import { describe, expect, test } from "bun:test";
import { LmStudioClient, ServerCrashError } from "../src/apiClient";

function sseResponse(events: string[], usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(`data: ${evt}\n\n`));
      }
      if (usage) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("LmStudioClient.completion", () => {
  test("streams tokens and computes throughput + TTFT from usage totals", async () => {
    const events = [
      JSON.stringify({ choices: [{ text: "Hello" }] }),
      JSON.stringify({ choices: [{ text: " world" }] }),
    ];
    let capturedRequest: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedRequest = { url, body: JSON.parse(init.body as string) };
      return sseResponse(events, { prompt_tokens: 12, completion_tokens: 2 });
    }) as unknown as typeof fetch;

    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    const result = await client.completion({ model: "test-model", prompt: "hi", maxTokens: 10 });

    expect(result.text).toBe("Hello world");
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(2);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.decodeTokPerSec).toBeGreaterThanOrEqual(0);
    expect(capturedRequest?.url).toBe("http://127.0.0.1:1234/v1/completions");
    expect((capturedRequest?.body as Record<string, unknown>).stream).toBe(true);
  });

  test("regression: falls back to counting delta events when the server never sends a usage chunk", async () => {
    // Some LM Studio/llama.cpp server configurations don't honor
    // stream_options.include_usage on /v1/completions and simply never send
    // a trailing usage chunk. Previously this left completionTokens at its
    // initial 0, so decodeTokPerSec was always 0 — failing every model in
    // Phase 1's >=10 tok/sec gate regardless of its real speed.
    const events = Array.from({ length: 5 }, (_, i) => JSON.stringify({ choices: [{ text: `tok${i} ` }] }));
    const fetchImpl = (async () => sseResponse(events)) as unknown as typeof fetch; // no usage arg -> none sent
    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });

    const result = await client.completion({ model: "test-model", prompt: "hi there", maxTokens: 10 });

    expect(result.completionTokens).toBe(5);
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.decodeTokPerSec).toBeGreaterThan(0);
  });

  test("prefers server-reported usage over the delta-count fallback when both are available", async () => {
    const events = [JSON.stringify({ choices: [{ text: "a" }] }), JSON.stringify({ choices: [{ text: "b" }] })];
    const fetchImpl = (async () => sseResponse(events, { prompt_tokens: 40, completion_tokens: 2 })) as unknown as typeof fetch;
    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });

    const result = await client.completion({ model: "test-model", prompt: "hi", maxTokens: 10 });
    expect(result.completionTokens).toBe(2);
    expect(result.promptTokens).toBe(40);
  });

  test("wraps a connection-refused failure in ServerCrashError", async () => {
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      (err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;

    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    await expect(client.completion({ model: "test-model", prompt: "hi", maxTokens: 10 })).rejects.toBeInstanceOf(
      ServerCrashError,
    );
  });

  test("wraps a non-2xx HTTP response in an error", async () => {
    const fetchImpl = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    await expect(client.completion({ model: "test-model", prompt: "hi", maxTokens: 10 })).rejects.toThrow(/400/);
  });

  test("applies a 120 second AbortSignal timeout to every request", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return sseResponse([JSON.stringify({ choices: [{ text: "x" }] })], { prompt_tokens: 1, completion_tokens: 1 });
    }) as unknown as typeof fetch;

    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    await client.completion({ model: "test-model", prompt: "hi", maxTokens: 10 });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("LmStudioClient.healthCheck", () => {
  test("returns true when the server responds ok", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    expect(await client.healthCheck()).toBe(true);
  });

  test("throws ServerCrashError when the port is unbound", async () => {
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      (err as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;
    const client = new LmStudioClient({ baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    await expect(client.healthCheck()).rejects.toBeInstanceOf(ServerCrashError);
  });
});

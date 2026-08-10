// HTTP seam for talking to LM Studio's OpenAI-compatible server. See spec:
// "API Communication" and user stories 11 (2-minute timeout) and 12 (hard crash
// detection on ECONNREFUSED / unbound port).

const REQUEST_TIMEOUT_MS = 120_000;

/** Raised when LM Studio's server is unreachable — a hard crash per the spec,
 * which the orchestrator must treat as fatal rather than a per-model failure. */
export class ServerCrashError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ServerCrashError";
  }
}

export interface CompletionRequest {
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  timeToFirstTokenMs: number;
  totalTimeMs: number;
  prefillTokPerSec: number;
  decodeTokPerSec: number;
}

export interface LmStudioClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return code === "ECONNREFUSED" || /ECONNREFUSED/.test(err.message);
}

interface SseChoiceDelta {
  text?: string;
}

interface SseChunk {
  choices?: SseChoiceDelta[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LmStudioClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: LmStudioClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "http://127.0.0.1:1234/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Issues a streaming /v1/completions request and derives prefill/decode throughput. */
  async completion(req: CompletionRequest): Promise<CompletionResult> {
    const start = this.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          prompt: req.prompt,
          max_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new ServerCrashError("LM Studio server is unreachable (connection refused on port 1234)", err);
      }
      throw err;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LM Studio completion request failed with status ${response.status}: ${body}`);
    }
    if (!response.body) {
      throw new Error("LM Studio completion response had no body");
    }

    let text = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let firstTokenAt: number | undefined;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const rawEvent of events) {
        const line = rawEvent.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload === "[DONE]") continue;

        const chunk = JSON.parse(payload) as SseChunk;
        const delta = chunk.choices?.[0]?.text;
        if (delta) {
          if (firstTokenAt === undefined) firstTokenAt = this.now();
          text += delta;
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        }
      }
    }

    const end = this.now();
    const timeToFirstTokenMs = (firstTokenAt ?? end) - start;
    const decodeTimeMs = Math.max(end - (firstTokenAt ?? end), 1);
    const totalTimeMs = end - start;

    return {
      text,
      promptTokens,
      completionTokens,
      timeToFirstTokenMs,
      totalTimeMs,
      prefillTokPerSec: promptTokens / Math.max(timeToFirstTokenMs / 1000, 0.001),
      decodeTokPerSec: completionTokens / (decodeTimeMs / 1000),
    };
  }

  /** GET /v1/models — used as a lightweight liveness check for port 1234. */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch (err) {
      if (isConnectionRefused(err)) {
        throw new ServerCrashError("LM Studio server is unreachable (connection refused on port 1234)", err);
      }
      throw err;
    }
  }
}

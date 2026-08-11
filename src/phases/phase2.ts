// Phase 2: Capability & Sanity Filter. See spec section 3 and user story 4.
// Submits a TypeScript AST-parsing prompt that requires strict JSON tool-calling
// output, then validates JSON structure, schema shape, and absence of
// degenerate repetition loops before a candidate is allowed to proceed to
// the more expensive Phase 3 tuning.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LmStudioClient } from "../apiClient";
import { loadModel } from "../lmsCli";
import type { CommandRunner } from "../subprocess";
import type { ModelConfig, Phase2Result } from "../types";

export const PHASE2_CONTEXT_LENGTH = 8192;
// Generous headroom rather than the spec's originally literal 300: reasoning-
// tuned models (e.g. Magistral, Qwen3-thinking variants) commonly emit a
// chain-of-thought preamble before their final answer, and 300 tokens was
// frequently consumed entirely by that preamble — truncating the response
// before it ever reached the actual JSON and failing every such model with
// a false "invalid JSON" verdict regardless of real capability.
export const PHASE2_MAX_TOKENS = 1024;

export const DEFAULT_FAILURE_LOG_DIR = "./data/phase2-failures";

export const PHASE2_PROMPT = `You are a TypeScript AST analysis tool. Given the function below, respond with
ONLY a single JSON object (no prose, no markdown fences) describing its signature using this exact shape:
{"tool":"extract_function_signature","functionName":string,"parameters":[{"name":string,"type":string}],"returnType":string}

function add(a: number, b: number): number {
  return a + b;
}`;

interface AstToolCall {
  tool: string;
  functionName: string;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
}

function isValidAstToolCall(value: unknown): value is AstToolCall {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.tool !== "string" || typeof obj.functionName !== "string" || typeof obj.returnType !== "string") {
    return false;
  }
  if (!Array.isArray(obj.parameters)) return false;
  return obj.parameters.every(
    (p) => typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).name === "string" && typeof (p as Record<string, unknown>).type === "string",
  );
}

/**
 * Finds every top-level balanced {...} substring in free-form text, tracking
 * string literals so braces inside quoted strings don't throw off the depth
 * count. Returns them in the order they appear.
 */
function findJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
}

/**
 * Extracts the model's actual JSON answer from free-form text. Tries
 * candidate balanced-brace objects from LAST to first, since models that
 * reason before answering put their real final answer at the end — an
 * earlier naive "first { to last }" span would instead capture (and fail to
 * parse) a concatenation spanning from an example/draft brace in the
 * reasoning all the way through the true answer.
 */
function extractJsonObject(text: string): unknown {
  const candidates = findJsonObjectCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]!);
    } catch {
      // Not valid JSON on its own (e.g. an example fragment mid-reasoning) — try the previous one.
    }
  }
  throw new Error("no parsable JSON object found in output");
}

/**
 * Detects degenerate output where a short word sequence repeats many times
 * back-to-back — a common failure mode for unstable quantized models that
 * fall into a decoding loop instead of terminating.
 */
export function hasRepetitionLoop(text: string, minRepeats = 4, maxPatternWords = 6): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let patternLen = 1; patternLen <= maxPatternWords; patternLen++) {
    for (let start = 0; start + patternLen * minRepeats <= words.length; start++) {
      const pattern = words.slice(start, start + patternLen).join(" ");
      let repeats = 1;
      let idx = start + patternLen;
      while (idx + patternLen <= words.length && words.slice(idx, idx + patternLen).join(" ") === pattern) {
        repeats++;
        idx += patternLen;
      }
      if (repeats >= minRepeats) return true;
    }
  }
  return false;
}

export function validatePhase2Output(text: string): { passed: boolean; reason?: string; parsedJson?: unknown } {
  if (hasRepetitionLoop(text)) {
    return { passed: false, reason: "output contains an infinite repetition loop" };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return { passed: false, reason: "output did not contain valid JSON" };
  }

  if (!isValidAstToolCall(parsed)) {
    return { passed: false, reason: "JSON did not match the required tool-call schema" };
  }

  return { passed: true, parsedJson: parsed };
}

function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Saves the full prompt + raw completion for a failed Phase 2 check, for offline diagnosis. */
async function saveFailureLog(
  dir: string,
  modelKey: string,
  info: { reason?: string; prompt: string; rawResponse: string },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const content = [
    `Model: ${modelKey}`,
    `Reason: ${info.reason ?? "unknown"}`,
    "",
    "--- Prompt ---",
    info.prompt,
    "",
    "--- Raw Response ---",
    info.rawResponse,
    "",
  ].join("\n");
  await Bun.write(join(dir, `${sanitizeForFileName(modelKey)}.txt`), content);
}

export interface Phase2Deps {
  runner: CommandRunner;
  client: Pick<LmStudioClient, "completion">;
  /** Where to save the raw response when validation fails. Defaults to DEFAULT_FAILURE_LOG_DIR. */
  failureLogDir?: string;
}

export async function runPhase2(model: ModelConfig, deps: Phase2Deps): Promise<Phase2Result> {
  await loadModel(deps.runner, model.modelKey, { contextLength: PHASE2_CONTEXT_LENGTH });

  const result = await deps.client.completion({
    model: model.modelKey,
    prompt: PHASE2_PROMPT,
    maxTokens: PHASE2_MAX_TOKENS,
  });

  const validation = validatePhase2Output(result.text);

  if (!validation.passed) {
    await saveFailureLog(deps.failureLogDir ?? DEFAULT_FAILURE_LOG_DIR, model.modelKey, {
      reason: validation.reason,
      prompt: PHASE2_PROMPT,
      rawResponse: result.text,
    });
  }

  return { modelKey: model.modelKey, ...validation };
}

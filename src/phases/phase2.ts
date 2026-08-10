// Phase 2: Capability & Sanity Filter. See spec section 3 and user story 4.
// Submits a TypeScript AST-parsing prompt that requires strict JSON tool-calling
// output, then validates JSON structure, schema shape, and absence of
// degenerate repetition loops before a candidate is allowed to proceed to
// the more expensive Phase 3 tuning.

import type { LmStudioClient } from "../apiClient";
import { loadModel } from "../lmsCli";
import type { CommandRunner } from "../subprocess";
import type { ModelConfig, Phase2Result } from "../types";

export const PHASE2_CONTEXT_LENGTH = 8192;
export const PHASE2_MAX_TOKENS = 300;

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

/** Extracts the first balanced {...} JSON object found in free-form text. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in output");
  }
  return JSON.parse(text.slice(start, end + 1));
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

export interface Phase2Deps {
  runner: CommandRunner;
  client: Pick<LmStudioClient, "completion">;
}

export async function runPhase2(model: ModelConfig, deps: Phase2Deps): Promise<Phase2Result> {
  await loadModel(deps.runner, model.modelKey, { contextLength: PHASE2_CONTEXT_LENGTH });

  const result = await deps.client.completion({
    model: model.modelKey,
    prompt: PHASE2_PROMPT,
    maxTokens: PHASE2_MAX_TOKENS,
  });

  const validation = validatePhase2Output(result.text);
  return { modelKey: model.modelKey, ...validation };
}

// Phase 1: High-Speed Ping Filter. See spec section 2 and user story 3.
// Loads a candidate at a small context and rejects anything decoding below
// 10 tok/sec before any time is spent tuning it further.

import type { LmStudioClient } from "../apiClient";
import { loadModel } from "../lmsCli";
import type { CommandRunner } from "../subprocess";
import type { ModelConfig, Phase1Result } from "../types";

export const PHASE1_CONTEXT_LENGTH = 4096;
export const PHASE1_MAX_TOKENS = 10;
export const PHASE1_MIN_TOK_PER_SEC = 10.0;
const PHASE1_PROMPT = "Reply with a short greeting.";

export interface Phase1Deps {
  runner: CommandRunner;
  client: Pick<LmStudioClient, "completion">;
}

export async function runPhase1(model: ModelConfig, deps: Phase1Deps): Promise<Phase1Result> {
  await loadModel(deps.runner, model.modelKey, { contextLength: PHASE1_CONTEXT_LENGTH });

  const result = await deps.client.completion({
    model: model.modelKey,
    prompt: PHASE1_PROMPT,
    maxTokens: PHASE1_MAX_TOKENS,
  });

  return {
    modelKey: model.modelKey,
    tokPerSec: result.decodeTokPerSec,
    passed: result.decodeTokPerSec >= PHASE1_MIN_TOK_PER_SEC,
  };
}

// Phase 3: Stage-Gate Hyperparameter & Context Tuner. See spec section 4 and
// user stories 5-8. Enforces Q8_0 KV cache quantization, verifies GPU layer
// offload against hardware telemetry, then climbs a context ladder until a
// guardrail (system RAM, shared GPU memory, or decode-speed regression) trips.

import type { LmStudioClient } from "../apiClient";
import { createLoadCapabilities, loadModel, type LoadCapabilities } from "../lmsCli";
import type { CommandRunner } from "../subprocess";
import type { ContextLadderStep, HardwareSnapshot, ModelConfig, Phase3TuningProfile } from "../types";

export const CONTEXT_LADDER = [8192, 16384, 24576, 32768, 49152, 65536] as const;

export const OFFLOAD_MAX_SHARED_GPU_MB = 300;
export const OFFLOAD_MIN_FREE_VRAM_MB = 1500;
/** Fractions of model layers offloaded to GPU, tried from full offload down to CPU-only. */
export const GPU_OFFLOAD_RATIO_LADDER = [1, 0.75, 0.5, 0.25, 0] as const;

export const RAM_GUARDRAIL_PERCENT = 90;
export const SHARED_GPU_GUARDRAIL_MB = 300;
export const DECODE_SPEED_DROP_GUARDRAIL_PERCENT = 15;

const PHASE3_PROMPT = "Summarize the purpose of a binary search tree in two sentences.";
const PHASE3_MAX_TOKENS = 64;

export interface HardwareProvider {
  getSnapshot(): Promise<HardwareSnapshot>;
}

export function describeOffload(ratio: number): string {
  if (ratio >= 1) return "max";
  if (ratio <= 0) return "cpu-only";
  return `${Math.round(ratio * 100)}%`;
}

function offloadSatisfiesConstraints(snapshot: HardwareSnapshot): boolean {
  return snapshot.sharedGpuMemoryMB <= OFFLOAD_MAX_SHARED_GPU_MB && snapshot.dedicatedVramFreeMB >= OFFLOAD_MIN_FREE_VRAM_MB;
}

/**
 * Loads the candidate at decreasing GPU offload ratios until Shared GPU Host
 * Memory and Dedicated VRAM headroom both satisfy the configured thresholds.
 */
export async function resolveGpuOffload(
  runner: CommandRunner,
  hardware: HardwareProvider,
  modelKey: string,
  contextLength: number,
  capabilities: LoadCapabilities = createLoadCapabilities(),
): Promise<{ offload: number; snapshot: HardwareSnapshot }> {
  for (const ratio of GPU_OFFLOAD_RATIO_LADDER) {
    console.log(`${modelKey} — Phase 3: trying GPU offload ${describeOffload(ratio)}...`);
    await loadModel(runner, modelKey, { contextLength, gpuOffloadLayers: ratio, kvCacheQuant: "Q8_0" }, capabilities);
    const snapshot = await hardware.getSnapshot();
    const ok = offloadSatisfiesConstraints(snapshot);
    console.log(
      `${modelKey} — Phase 3: offload ${describeOffload(ratio)} → shared GPU ${snapshot.sharedGpuMemoryMB}MB, ` +
        `free VRAM ${snapshot.dedicatedVramFreeMB}MB — ${ok ? "OK" : "too tight, stepping down"}`,
    );
    if (ok) {
      return { offload: ratio, snapshot };
    }
  }
  throw new Error(
    `No GPU offload level for "${modelKey}" satisfies the memory constraints ` +
      `(shared GPU memory <= ${OFFLOAD_MAX_SHARED_GPU_MB}MB, free VRAM >= ${OFFLOAD_MIN_FREE_VRAM_MB}MB)`,
  );
}

/**
 * Climbs CONTEXT_LADDER, recording a ContextLadderStep at every rung. Scaling
 * halts the first time system RAM, shared GPU memory, or decode speed (relative
 * to the 8k baseline) breaches its guardrail; the failing step is still recorded
 * for the report, but maxRecommendedContext stops at the last successful rung.
 *
 * `alreadyLoadedAtContext`, when it matches the first rung, skips that rung's
 * loadModel() call — resolveGpuOffload() already left the model loaded at
 * exactly that context+offload right before this runs, so reloading it again
 * immediately would be a pure-waste extra unload/load cycle (and, per a
 * reported native llama.cpp crash after several such cycles in quick
 * succession, one worth not adding unnecessarily).
 */
export async function runContextLadder(
  runner: CommandRunner,
  client: Pick<LmStudioClient, "completion">,
  hardware: HardwareProvider,
  modelKey: string,
  gpuOffload: number,
  alreadyLoadedAtContext?: number,
  capabilities: LoadCapabilities = createLoadCapabilities(),
): Promise<{ maxRecommendedContext: number; ladderHistory: ContextLadderStep[] }> {
  const ladderHistory: ContextLadderStep[] = [];
  let maxRecommendedContext = 0;
  let baselineDecodeTokPerSec: number | undefined;

  for (const contextLength of CONTEXT_LADDER) {
    console.log(`${modelKey} — Phase 3: trying context ${contextLength}...`);
    if (contextLength !== alreadyLoadedAtContext) {
      await loadModel(runner, modelKey, { contextLength, gpuOffloadLayers: gpuOffload, kvCacheQuant: "Q8_0" }, capabilities);
    }
    const result = await client.completion({ model: modelKey, prompt: PHASE3_PROMPT, maxTokens: PHASE3_MAX_TOKENS });
    const snapshot = await hardware.getSnapshot();

    if (baselineDecodeTokPerSec === undefined) baselineDecodeTokPerSec = result.decodeTokPerSec;
    const speedDropPercent =
      baselineDecodeTokPerSec > 0 ? ((baselineDecodeTokPerSec - result.decodeTokPerSec) / baselineDecodeTokPerSec) * 100 : 0;

    const step: ContextLadderStep = {
      contextLength,
      prefillTokPerSec: result.prefillTokPerSec,
      decodeTokPerSec: result.decodeTokPerSec,
      timeToFirstTokenMs: result.timeToFirstTokenMs,
      snapshot,
      speedDropPercent,
    };
    ladderHistory.push(step);

    const guardrailTripped =
      snapshot.ramUsedPercent >= RAM_GUARDRAIL_PERCENT ||
      snapshot.sharedGpuMemoryMB >= SHARED_GPU_GUARDRAIL_MB ||
      speedDropPercent >= DECODE_SPEED_DROP_GUARDRAIL_PERCENT;

    console.log(
      `${modelKey} — Phase 3: context ${contextLength} → decode ${result.decodeTokPerSec.toFixed(1)} tok/s ` +
        `(drop ${speedDropPercent.toFixed(1)}%), RAM ${snapshot.ramUsedPercent}%, shared GPU ${snapshot.sharedGpuMemoryMB}MB ` +
        `— ${guardrailTripped ? "guardrail tripped, stopping here" : "OK"}`,
    );

    if (guardrailTripped) break;
    maxRecommendedContext = contextLength;
  }

  // If scaling stopped because a rung tripped a guardrail, the model is
  // currently still loaded at that over-limit configuration — the loop's
  // last loadModel() call was for the failing rung, not the recommended one.
  // Reload at maxRecommendedContext so whatever's left loaded actually
  // matches what this profile reports (Phase 4 runs against it next).
  const lastAttempted = ladderHistory[ladderHistory.length - 1]?.contextLength;
  if (maxRecommendedContext > 0 && lastAttempted !== maxRecommendedContext) {
    console.log(`${modelKey} — Phase 3: reloading at recommended context ${maxRecommendedContext}...`);
    await loadModel(
      runner,
      modelKey,
      { contextLength: maxRecommendedContext, gpuOffloadLayers: gpuOffload, kvCacheQuant: "Q8_0" },
      capabilities,
    );
  }

  return { maxRecommendedContext, ladderHistory };
}

export interface Phase3Deps {
  runner: CommandRunner;
  client: Pick<LmStudioClient, "completion">;
  hardware: HardwareProvider;
  /**
   * Shared across every loadModel() call in this phase (and, when passed in
   * from the orchestrator, across every other model in the run too) so an
   * unsupported --kv-cache-quant is only ever discovered once, not re-learned
   * on every rung of the offload/context ladders. Defaults to a fresh
   * (per-call) instance when not provided.
   */
  loadCapabilities?: LoadCapabilities;
}

export async function runPhase3(model: ModelConfig, deps: Phase3Deps): Promise<Phase3TuningProfile> {
  const capabilities = deps.loadCapabilities ?? createLoadCapabilities();
  const { offload } = await resolveGpuOffload(
    deps.runner,
    deps.hardware,
    model.modelKey,
    CONTEXT_LADDER[0],
    capabilities,
  );
  // resolveGpuOffload already left the model loaded at CONTEXT_LADDER[0] with
  // the winning offload — tell the ladder so it doesn't immediately redo that
  // exact same load.
  const { maxRecommendedContext, ladderHistory } = await runContextLadder(
    deps.runner,
    deps.client,
    deps.hardware,
    model.modelKey,
    offload,
    CONTEXT_LADDER[0],
    capabilities,
  );

  return {
    modelKey: model.modelKey,
    quant: model.quant,
    verifiedGpuOffload: describeOffload(offload),
    kvCacheQuant: "Q8_0",
    maxRecommendedContext,
    ladderHistory,
  };
}

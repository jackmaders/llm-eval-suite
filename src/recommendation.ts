// Suggests a different quantization when a model's hardware footprint at its
// tuned context suggests the current quant isn't a great fit — surfaced as
// extra warnings in the Markdown report, not applied automatically (the
// suite never picks a "winner"; see spec "Out of Scope").

import type { HardwareSnapshot, Phase3TuningProfile } from "./types";

/** Ordered least- to most-precise. Neighbors are the natural "one step up/down" quant to try. */
const QUANT_RANKING = [
  "Q2_K",
  "Q3_K_S",
  "Q3_K_M",
  "Q3_K_L",
  "Q4_K_S",
  "Q4_K_M",
  "Q5_K_S",
  "Q5_K_M",
  "Q6_K",
  "Q8_0",
  "F16",
  "BF16",
  "F32",
];

// A model is "tight" if any of these are true at its recommended context —
// getting close enough to Phase 3's own guardrails (RAM_GUARDRAIL_PERCENT=90,
// SHARED_GPU_GUARDRAIL_MB=300, OFFLOAD_MIN_FREE_VRAM_MB=1500 in phase3.ts)
// that a smaller quant would buy meaningful headroom back.
export const TIGHT_RAM_PERCENT = 80;
export const TIGHT_SHARED_GPU_MB = 200;
export const TIGHT_FREE_VRAM_MB = 2000;

// A model is "loose" if both hold — comfortably far from every guardrail —
// suggesting a less-compressed quant could improve quality for free.
export const LOOSE_RAM_PERCENT = 40;
export const LOOSE_FREE_VRAM_MB = 6000;

export interface QuantRecommendation {
  direction: "more-compression" | "less-compression";
  suggestedQuant?: string;
  reason: string;
}

function isTight(snapshot: HardwareSnapshot): boolean {
  return (
    snapshot.ramUsedPercent >= TIGHT_RAM_PERCENT ||
    snapshot.sharedGpuMemoryMB >= TIGHT_SHARED_GPU_MB ||
    snapshot.dedicatedVramFreeMB <= TIGHT_FREE_VRAM_MB
  );
}

function isLoose(snapshot: HardwareSnapshot): boolean {
  return snapshot.ramUsedPercent <= LOOSE_RAM_PERCENT && snapshot.dedicatedVramFreeMB >= LOOSE_FREE_VRAM_MB;
}

function neighborQuant(quant: string, offset: 1 | -1): string | undefined {
  const index = QUANT_RANKING.indexOf(quant.toUpperCase());
  if (index === -1) return undefined;
  return QUANT_RANKING[index + offset];
}

/**
 * Suggests a different quantization for a tuned model based on how close it
 * ran to Phase 3's memory guardrails: tight headroom -> a smaller/more
 * compressed quant would leave more room; lots of spare headroom -> a
 * larger/less compressed quant would likely improve quality for free.
 * Returns undefined when usage looks like a reasonable middle ground, or
 * when there's no ladder data to judge from at all.
 */
export function recommendQuantChange(profile: Phase3TuningProfile): QuantRecommendation | undefined {
  const referenceStep =
    profile.ladderHistory.find((step) => step.contextLength === profile.maxRecommendedContext) ??
    profile.ladderHistory[0];
  if (!referenceStep) return undefined;

  const { snapshot } = referenceStep;
  const context = referenceStep.contextLength;

  if (isTight(snapshot)) {
    return {
      direction: "more-compression",
      suggestedQuant: neighborQuant(profile.quant, -1),
      reason:
        `at ${context} tokens this model runs close to its RAM/VRAM ceiling ` +
        `(RAM ${snapshot.ramUsedPercent}%, shared GPU ${snapshot.sharedGpuMemoryMB}MB, ` +
        `free VRAM ${snapshot.dedicatedVramFreeMB}MB) — a smaller quantization would leave more headroom.`,
    };
  }

  if (isLoose(snapshot)) {
    return {
      direction: "less-compression",
      suggestedQuant: neighborQuant(profile.quant, 1),
      reason:
        `at ${context} tokens this model leaves plenty of headroom unused ` +
        `(RAM ${snapshot.ramUsedPercent}%, free VRAM ${snapshot.dedicatedVramFreeMB}MB) — ` +
        `a less aggressive quantization would likely improve quality at little extra cost.`,
    };
  }

  return undefined;
}

import { describe, expect, test } from "bun:test";
import { recommendQuantChange } from "../src/recommendation";
import type { ContextLadderStep, HardwareSnapshot, Phase3TuningProfile } from "../src/types";

function snapshot(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
  return { ramUsedPercent: 50, ramUsedGB: 16, dedicatedVramFreeMB: 5000, sharedGpuMemoryMB: 0, ...overrides };
}

function step(overrides: Partial<ContextLadderStep> = {}): ContextLadderStep {
  return {
    contextLength: 8192,
    prefillTokPerSec: 500,
    decodeTokPerSec: 20,
    timeToFirstTokenMs: 100,
    snapshot: snapshot(),
    speedDropPercent: 0,
    ...overrides,
  };
}

function profile(overrides: Partial<Phase3TuningProfile> = {}): Phase3TuningProfile {
  return {
    modelKey: "model-a",
    quant: "Q4_K_M",
    verifiedGpuOffload: "max",
    kvCacheQuant: "Q8_0",
    maxRecommendedContext: 8192,
    ladderHistory: [step()],
    ...overrides,
  };
}

describe("recommendQuantChange", () => {
  test("recommends more compression when RAM usage is near the guardrail at the recommended context", () => {
    const p = profile({ ladderHistory: [step({ snapshot: snapshot({ ramUsedPercent: 88 }) })] });
    const rec = recommendQuantChange(p);
    expect(rec?.direction).toBe("more-compression");
    expect(rec?.suggestedQuant).toBe("Q4_K_S");
  });

  test("recommends more compression when shared GPU memory is climbing toward the guardrail", () => {
    const p = profile({ ladderHistory: [step({ snapshot: snapshot({ sharedGpuMemoryMB: 250 }) })] });
    expect(recommendQuantChange(p)?.direction).toBe("more-compression");
  });

  test("recommends more compression when free VRAM is nearly exhausted", () => {
    const p = profile({ ladderHistory: [step({ snapshot: snapshot({ dedicatedVramFreeMB: 1200 }) })] });
    expect(recommendQuantChange(p)?.direction).toBe("more-compression");
  });

  test("recommends less compression when there is plenty of unused headroom", () => {
    const p = profile({
      quant: "Q4_K_M",
      ladderHistory: [step({ snapshot: snapshot({ ramUsedPercent: 20, dedicatedVramFreeMB: 9000 }) })],
    });
    const rec = recommendQuantChange(p);
    expect(rec?.direction).toBe("less-compression");
    expect(rec?.suggestedQuant).toBe("Q5_K_S");
  });

  test("makes no recommendation when usage is comfortably in the middle", () => {
    const p = profile({ ladderHistory: [step({ snapshot: snapshot({ ramUsedPercent: 55, dedicatedVramFreeMB: 4000 }) })] });
    expect(recommendQuantChange(p)).toBeUndefined();
  });

  test("evaluates the last successful ladder rung, not a later rung that already tripped a guardrail", () => {
    const p = profile({
      maxRecommendedContext: 16384,
      ladderHistory: [
        step({ contextLength: 8192, snapshot: snapshot({ ramUsedPercent: 40 }) }),
        step({ contextLength: 16384, snapshot: snapshot({ ramUsedPercent: 45 }) }),
        step({ contextLength: 24576, snapshot: snapshot({ ramUsedPercent: 95 }) }), // tripped the guardrail
      ],
    });
    expect(recommendQuantChange(p)).toBeUndefined();
  });

  test("falls back to the first rung's snapshot when the model failed at 8k with no successful step", () => {
    const p = profile({
      maxRecommendedContext: 0,
      ladderHistory: [step({ contextLength: 8192, snapshot: snapshot({ ramUsedPercent: 96 }) })],
    });
    expect(recommendQuantChange(p)?.direction).toBe("more-compression");
  });

  test("omits a suggested quant name when the current quant isn't in the known ranking", () => {
    const p = profile({
      quant: "mystery-quant",
      ladderHistory: [step({ snapshot: snapshot({ ramUsedPercent: 90 }) })],
    });
    const rec = recommendQuantChange(p);
    expect(rec?.direction).toBe("more-compression");
    expect(rec?.suggestedQuant).toBeUndefined();
  });

  test("omits a suggested quant name at the extreme ends of the ranking", () => {
    const tightest = profile({ quant: "Q2_K", ladderHistory: [step({ snapshot: snapshot({ ramUsedPercent: 90 }) })] });
    expect(recommendQuantChange(tightest)?.suggestedQuant).toBeUndefined();

    const loosest = profile({
      quant: "F32",
      ladderHistory: [step({ snapshot: snapshot({ ramUsedPercent: 10, dedicatedVramFreeMB: 20000 }) })],
    });
    expect(recommendQuantChange(loosest)?.suggestedQuant).toBeUndefined();
  });

  test("returns undefined when there is no ladder history at all", () => {
    expect(recommendQuantChange(profile({ ladderHistory: [] }))).toBeUndefined();
  });
});

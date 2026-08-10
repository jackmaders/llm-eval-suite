import { describe, expect, test } from "bun:test";
import {
  CONTEXT_LADDER,
  describeOffload,
  resolveGpuOffload,
  runContextLadder,
  runPhase3,
} from "../src/phases/phase3";
import type { LmStudioClient } from "../src/apiClient";
import type { CommandRunner } from "../src/subprocess";
import type { HardwareSnapshot, ModelConfig } from "../src/types";

const model: ModelConfig = { modelKey: "model-a", quant: "Q4_K_M" };

function healthySnapshot(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
  return { ramUsedPercent: 40, ramUsedGB: 12, dedicatedVramFreeMB: 8000, sharedGpuMemoryMB: 0, ...overrides };
}

function recordingRunner(): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: async (_cmd, args) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
}

describe("describeOffload", () => {
  test("formats ratios as human-readable labels", () => {
    expect(describeOffload(1)).toBe("max");
    expect(describeOffload(0)).toBe("cpu-only");
    expect(describeOffload(0.5)).toBe("50%");
  });
});

describe("resolveGpuOffload", () => {
  test("accepts max offload immediately when memory constraints are satisfied", async () => {
    const { runner, calls } = recordingRunner();
    const hardware = { getSnapshot: async () => healthySnapshot() };
    const result = await resolveGpuOffload(runner, hardware, model.modelKey, 8192);
    expect(result.offload).toBe(1);
    expect(calls[0]).toContain("1");
  });

  test("steps down offload when shared GPU memory exceeds 300MB", async () => {
    const { runner } = recordingRunner();
    const snapshots = [
      healthySnapshot({ sharedGpuMemoryMB: 500 }),
      healthySnapshot({ sharedGpuMemoryMB: 500 }),
      healthySnapshot({ sharedGpuMemoryMB: 0 }),
    ];
    const hardware = { getSnapshot: async () => snapshots.shift() ?? healthySnapshot() };
    const result = await resolveGpuOffload(runner, hardware, model.modelKey, 8192);
    expect(result.offload).toBeLessThan(1);
  });

  test("steps down offload when free VRAM drops below 1500MB", async () => {
    const { runner } = recordingRunner();
    const snapshots = [healthySnapshot({ dedicatedVramFreeMB: 800 }), healthySnapshot({ dedicatedVramFreeMB: 4000 })];
    const hardware = { getSnapshot: async () => snapshots.shift() ?? healthySnapshot() };
    const result = await resolveGpuOffload(runner, hardware, model.modelKey, 8192);
    expect(result.offload).toBeLessThan(1);
  });

  test("throws when no offload level satisfies the memory constraints", async () => {
    const { runner } = recordingRunner();
    const hardware = { getSnapshot: async () => healthySnapshot({ dedicatedVramFreeMB: 200 }) };
    await expect(resolveGpuOffload(runner, hardware, model.modelKey, 8192)).rejects.toThrow(/offload/i);
  });
});

function completionAt(decodeTokPerSec: number) {
  return async () => ({
    text: "ok",
    promptTokens: 100,
    completionTokens: 50,
    timeToFirstTokenMs: 200,
    totalTimeMs: 3000,
    prefillTokPerSec: 500,
    decodeTokPerSec,
  });
}

describe("runContextLadder", () => {
  test("climbs the full ladder when nothing trips a guardrail", async () => {
    const { runner } = recordingRunner();
    const client: Pick<LmStudioClient, "completion"> = { completion: completionAt(20) };
    const hardware = { getSnapshot: async () => healthySnapshot() };
    const result = await runContextLadder(runner, client, hardware, model.modelKey, 1);

    expect(result.maxRecommendedContext).toBe(CONTEXT_LADDER.at(-1)!);
    expect(result.ladderHistory).toHaveLength(CONTEXT_LADDER.length);
  });

  test("halts when system RAM reaches 90%", async () => {
    const { runner } = recordingRunner();
    const client: Pick<LmStudioClient, "completion"> = { completion: completionAt(20) };
    let step = 0;
    const hardware = {
      getSnapshot: async () => {
        step++;
        return healthySnapshot({ ramUsedPercent: step === 3 ? 92 : 40 });
      },
    };
    const result = await runContextLadder(runner, client, hardware, model.modelKey, 1);
    expect(result.maxRecommendedContext).toBe(CONTEXT_LADDER[1]);
    expect(result.ladderHistory).toHaveLength(3);
  });

  test("halts when shared GPU memory reaches 300MB", async () => {
    const { runner } = recordingRunner();
    const client: Pick<LmStudioClient, "completion"> = { completion: completionAt(20) };
    let step = 0;
    const hardware = {
      getSnapshot: async () => {
        step++;
        return healthySnapshot({ sharedGpuMemoryMB: step === 2 ? 300 : 0 });
      },
    };
    const result = await runContextLadder(runner, client, hardware, model.modelKey, 1);
    expect(result.maxRecommendedContext).toBe(CONTEXT_LADDER[0]);
    expect(result.ladderHistory).toHaveLength(2);
  });

  test("halts when decode speed drops 15% or more versus the 8k baseline", async () => {
    const { runner } = recordingRunner();
    const speeds = [20, 19, 16]; // 16 is a 20% drop from baseline 20
    const client: Pick<LmStudioClient, "completion"> = {
      completion: async () => {
        const speed = speeds.shift() ?? 20;
        return {
          text: "ok",
          promptTokens: 100,
          completionTokens: 50,
          timeToFirstTokenMs: 200,
          totalTimeMs: 3000,
          prefillTokPerSec: 500,
          decodeTokPerSec: speed,
        };
      },
    };
    const hardware = { getSnapshot: async () => healthySnapshot() };
    const result = await runContextLadder(runner, client, hardware, model.modelKey, 1);
    expect(result.maxRecommendedContext).toBe(CONTEXT_LADDER[1]);
    expect(result.ladderHistory[2]?.speedDropPercent).toBeGreaterThanOrEqual(15);
  });
});

describe("runPhase3", () => {
  test("wires offload resolution and the context ladder into a tuning profile", async () => {
    const { runner } = recordingRunner();
    const client: Pick<LmStudioClient, "completion"> = { completion: completionAt(30) };
    const hardware = { getSnapshot: async () => healthySnapshot() };

    const profile = await runPhase3(model, { runner, client, hardware });

    expect(profile.modelKey).toBe("model-a");
    expect(profile.quant).toBe("Q4_K_M");
    expect(profile.kvCacheQuant).toBe("Q8_0");
    expect(profile.verifiedGpuOffload).toBe("max");
    expect(profile.maxRecommendedContext).toBe(CONTEXT_LADDER.at(-1)!);
    expect(profile.ladderHistory.length).toBeGreaterThan(0);
  });
});

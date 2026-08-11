import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerCrashError } from "../src/apiClient";
import { parsePhasesFlag, runPipeline } from "../src/orchestrator";
import { loadState, saveStateAtomic } from "../src/state";
import type { CommandRunner } from "../src/subprocess";
import type { ModelConfig, Phase1Result, Phase2Result, PipelineState } from "../src/types";

const workDirs: string[] = [];
afterEach(async () => {
  await Promise.all(workDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeWorkDir(): { statePath: string; dataDir: string } {
  const dir = join(tmpdir(), `llm-eval-suite-orch-${crypto.randomUUID()}`);
  workDirs.push(dir);
  return { statePath: join(dir, ".pipeline_state.json"), dataDir: dir };
}

/** Simulates the models LM Studio reports via `lms ls --json --variants`. */
function baseDeps(discoveredModels: ModelConfig[]) {
  const paths = makeWorkDir();
  return {
    paths,
    deps: {
      statePath: paths.statePath,
      dataDir: paths.dataDir,
      resume: false,
      runner: {
        run: async (cmd: string, args: string[]) => {
          if (cmd === "lms" && args[0] === "ls") {
            return { stdout: JSON.stringify(discoveredModels), stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      } as CommandRunner,
      client: { healthCheck: async () => true } as never,
      hardware: { getSnapshot: async () => ({ ramUsedPercent: 30, ramUsedGB: 10, dedicatedVramFreeMB: 9000, sharedGpuMemoryMB: 0 }) },
    },
  };
}

describe("parsePhasesFlag", () => {
  test("defaults to all four phases when the flag is absent", () => {
    expect(parsePhasesFlag(["--resume"])).toEqual(new Set([1, 2, 3, 4]));
  });

  test("parses a comma-separated subset", () => {
    expect(parsePhasesFlag(["--phases=1,2"])).toEqual(new Set([1, 2]));
  });

  test("tolerates whitespace around values", () => {
    expect(parsePhasesFlag(["--phases= 3 , 4 "])).toEqual(new Set([3, 4]));
  });

  test("throws on an out-of-range phase number", () => {
    expect(() => parsePhasesFlag(["--phases=1,5"])).toThrow(/1, 2, 3, 4/);
  });

  test("throws on an empty phase list", () => {
    expect(() => parsePhasesFlag(["--phases="])).toThrow(/at least one phase/i);
  });
});

describe("runPipeline", () => {
  test("discovers candidates from `lms ls --json --variants` and runs every phase for one that clears every gate", async () => {
    const models: ModelConfig[] = [{ modelKey: "model-a", quant: "Q4_K_M" }];
    const { paths, deps } = baseDeps(models);

    const calls: string[] = [];
    const lsCalls: string[][] = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        if (cmd === "lms" && args[0] === "ls") lsCalls.push(args);
        return deps.runner.run(cmd, args);
      },
    };

    const result = await runPipeline({
      ...deps,
      runner,
      now: () => "2026-08-10T00:00:00.000Z",
      phase1: async (m): Promise<Phase1Result> => {
        calls.push("phase1");
        return { modelKey: m.modelKey, tokPerSec: 20, passed: true };
      },
      phase2: async (m): Promise<Phase2Result> => {
        calls.push("phase2");
        return { modelKey: m.modelKey, passed: true };
      },
      phase3: async (m) => {
        calls.push("phase3");
        return {
          modelKey: m.modelKey,
          quant: m.quant,
          verifiedGpuOffload: "max",
          kvCacheQuant: "Q8_0" as const,
          maxRecommendedContext: 32768,
          ladderHistory: [],
        };
      },
      phase4: async (m) => {
        calls.push("phase4");
        return {
          modelKey: m.modelKey,
          passRatePercent: 100,
          syntaxErrorCount: 0,
          avgDecodeSpeed: 22,
          thermalDecayPercent: 1,
          workspaceDir: "/tmp/x",
        };
      },
    });

    expect(lsCalls[0]).toEqual(["ls", "--json", "--variants"]);
    expect(calls).toEqual(["phase1", "phase2", "phase3", "phase4"]);
    expect(result.state.completedPhases["model-a"]?.phase4Metrics?.passRatePercent).toBe(100);
    expect(result.reportMarkdown).toContain("model-a");

    const persisted = await loadState(paths.statePath);
    expect(persisted?.completedPhases["model-a"]?.phase3Profile?.maxRecommendedContext).toBe(32768);
  });

  test("discards a model at phase 1 and skips later phases", async () => {
    const models: ModelConfig[] = [{ modelKey: "model-slow", quant: "Q4_K_M" }];
    const { deps } = baseDeps(models);

    const calls: string[] = [];
    const result = await runPipeline({
      ...deps,
      phase1: async (m): Promise<Phase1Result> => {
        calls.push("phase1");
        return { modelKey: m.modelKey, tokPerSec: 3, passed: false };
      },
      phase2: async () => {
        calls.push("phase2");
        throw new Error("should not be called");
      },
      phase3: async () => {
        calls.push("phase3");
        throw new Error("should not be called");
      },
      phase4: async () => {
        calls.push("phase4");
        throw new Error("should not be called");
      },
    });

    expect(calls).toEqual(["phase1"]);
    expect(result.state.completedPhases["model-slow"]?.discardedAt).toBe("DISCARDED_PHASE1");
  });

  test("discards a model at phase 2 and skips phase 3/4", async () => {
    const models: ModelConfig[] = [{ modelKey: "model-b", quant: "Q4_K_M" }];
    const { deps } = baseDeps(models);

    const calls: string[] = [];
    const result = await runPipeline({
      ...deps,
      phase1: async (m): Promise<Phase1Result> => {
        calls.push("phase1");
        return { modelKey: m.modelKey, tokPerSec: 20, passed: true };
      },
      phase2: async (m): Promise<Phase2Result> => {
        calls.push("phase2");
        return { modelKey: m.modelKey, passed: false, reason: "invalid JSON" };
      },
      phase3: async () => {
        calls.push("phase3");
        throw new Error("should not be called");
      },
      phase4: async () => {
        calls.push("phase4");
        throw new Error("should not be called");
      },
    });

    expect(calls).toEqual(["phase1", "phase2"]);
    expect(result.state.completedPhases["model-b"]?.discardedAt).toBe("DISCARDED_PHASE2");
  });

  test("--resume skips phases already recorded in state", async () => {
    const models: ModelConfig[] = [{ modelKey: "model-a", quant: "Q4_K_M" }];
    const { paths, deps } = baseDeps(models);

    const priorState: PipelineState = {
      lastUpdated: "earlier",
      completedPhases: { "model-a": { phase1Passed: true, phase2Passed: true } },
    };
    await saveStateAtomic(paths.statePath, priorState);

    const calls: string[] = [];
    await runPipeline({
      ...deps,
      resume: true,
      phase1: async () => {
        calls.push("phase1");
        throw new Error("should not re-run");
      },
      phase2: async () => {
        calls.push("phase2");
        throw new Error("should not re-run");
      },
      phase3: async (m) => {
        calls.push("phase3");
        return {
          modelKey: m.modelKey,
          quant: m.quant,
          verifiedGpuOffload: "max",
          kvCacheQuant: "Q8_0" as const,
          maxRecommendedContext: 16384,
          ladderHistory: [],
        };
      },
      phase4: async (m) => {
        calls.push("phase4");
        return {
          modelKey: m.modelKey,
          passRatePercent: 80,
          syntaxErrorCount: 0,
          avgDecodeSpeed: 18,
          thermalDecayPercent: 2,
          workspaceDir: "/tmp/x",
        };
      },
    });

    expect(calls).toEqual(["phase3", "phase4"]);
  });

  test("aborts the whole run when the server crashes mid-pipeline", async () => {
    const models: ModelConfig[] = [
      { modelKey: "model-a", quant: "Q4_K_M" },
      { modelKey: "model-b", quant: "Q4_K_M" },
    ];
    const { paths, deps } = baseDeps(models);

    const calls: string[] = [];
    await expect(
      runPipeline({
        ...deps,
        phase1: async (m) => {
          calls.push(`phase1:${m.modelKey}`);
          if (m.modelKey === "model-b") throw new ServerCrashError("port 1234 unbound");
          return { modelKey: m.modelKey, tokPerSec: 20, passed: true };
        },
        phase2: async (m) => ({ modelKey: m.modelKey, passed: true }),
        phase3: async (m) => ({
          modelKey: m.modelKey,
          quant: m.quant,
          verifiedGpuOffload: "max",
          kvCacheQuant: "Q8_0" as const,
          maxRecommendedContext: 8192,
          ladderHistory: [],
        }),
        phase4: async (m) => ({
          modelKey: m.modelKey,
          passRatePercent: 100,
          syntaxErrorCount: 0,
          avgDecodeSpeed: 10,
          thermalDecayPercent: 0,
          workspaceDir: "/tmp/x",
        }),
      }),
    ).rejects.toBeInstanceOf(ServerCrashError);

    expect(calls).toEqual(["phase1:model-a", "phase1:model-b"]);
    const persisted = await loadState(paths.statePath);
    expect(persisted?.completedPhases["model-a"]?.phase4Metrics).toBeDefined();
    // The quant is recorded up front (known from discovery, before any phase
    // runs), so model-b has a partial record rather than none at all — but
    // nothing phase-related, since it crashed before phase1 completed.
    expect(persisted?.completedPhases["model-b"]).toEqual({ quant: "Q4_K_M" });
    expect(persisted?.completedPhases["model-b"]?.phase1Passed).toBeUndefined();
  });

  test("--phases restricts which phases run and skips the discard gate for phases not requested", async () => {
    const models: ModelConfig[] = [{ modelKey: "model-a", quant: "Q4_K_M" }];
    const { deps } = baseDeps(models);

    const calls: string[] = [];
    const result = await runPipeline({
      ...deps,
      phases: new Set([3]),
      phase1: async () => {
        calls.push("phase1");
        throw new Error("should not run — phase 1 wasn't requested");
      },
      phase2: async () => {
        calls.push("phase2");
        throw new Error("should not run — phase 2 wasn't requested");
      },
      phase3: async (m) => {
        calls.push("phase3");
        return {
          modelKey: m.modelKey,
          quant: m.quant,
          verifiedGpuOffload: "max",
          kvCacheQuant: "Q8_0" as const,
          maxRecommendedContext: 16384,
          ladderHistory: [],
        };
      },
      phase4: async () => {
        calls.push("phase4");
        throw new Error("should not run — phase 4 wasn't requested");
      },
    });

    expect(calls).toEqual(["phase3"]);
    expect(result.state.completedPhases["model-a"]?.discardedAt).toBeUndefined();
    expect(result.state.completedPhases["model-a"]?.phase3Profile?.maxRecommendedContext).toBe(16384);
    expect(result.state.completedPhases["model-a"]?.phase1Passed).toBeUndefined();
  });

  test("--phases=1,2 runs only the fast filters and stops there, even for a model that would pass", async () => {
    const models: ModelConfig[] = [{ modelKey: "model-a", quant: "Q4_K_M" }];
    const { deps } = baseDeps(models);

    const calls: string[] = [];
    const result = await runPipeline({
      ...deps,
      phases: new Set([1, 2]),
      phase1: async (m) => {
        calls.push("phase1");
        return { modelKey: m.modelKey, tokPerSec: 20, passed: true };
      },
      phase2: async (m) => {
        calls.push("phase2");
        return { modelKey: m.modelKey, passed: true };
      },
      phase3: async () => {
        calls.push("phase3");
        throw new Error("should not run — phase 3 wasn't requested");
      },
      phase4: async () => {
        calls.push("phase4");
        throw new Error("should not run — phase 4 wasn't requested");
      },
    });

    expect(calls).toEqual(["phase1", "phase2"]);
    expect(result.state.completedPhases["model-a"]?.phase1TokPerSec).toBe(20);
    expect(result.state.completedPhases["model-a"]?.phase3Profile).toBeUndefined();
  });

  test("halts before running anything when lms ls reports no downloaded models", async () => {
    const { deps } = baseDeps([]);

    await expect(
      runPipeline({
        ...deps,
        phase1: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toThrow(/no downloaded models/i);
  });
});

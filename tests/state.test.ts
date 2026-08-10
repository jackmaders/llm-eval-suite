import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasCompletedPhase1,
  hasCompletedPhase2,
  hasCompletedPhase3,
  hasCompletedPhase4,
  loadState,
  saveStateAtomic,
} from "../src/state";
import type { PipelineState } from "../src/types";

const STATE_PATH = join(tmpdir(), "llm-eval-suite-state.test.json");

describe("state persistence", () => {
  beforeEach(async () => {
    await rm(STATE_PATH, { force: true });
  });
  afterEach(async () => {
    await rm(STATE_PATH, { force: true });
  });

  test("loadState returns null when no state file exists", async () => {
    expect(await loadState(STATE_PATH)).toBeNull();
  });

  test("saveStateAtomic then loadState round-trips the pipeline state", async () => {
    const state: PipelineState = {
      lastUpdated: "2026-08-10T00:00:00.000Z",
      completedPhases: { "model-a": { phase1Passed: true } },
    };
    await saveStateAtomic(STATE_PATH, state);
    expect(await loadState(STATE_PATH)).toEqual(state);
  });

  test("saveStateAtomic leaves no partial temp file behind", async () => {
    const state: PipelineState = { lastUpdated: "now", completedPhases: {} };
    await saveStateAtomic(STATE_PATH, state);
    const glob = new Bun.Glob(`${STATE_PATH}.tmp*`);
    const leftovers = await Array.fromAsync(glob.scan({ absolute: true }));
    expect(leftovers).toEqual([]);
  });

  test("loadState throws on corrupt JSON rather than silently resetting", async () => {
    await Bun.write(STATE_PATH, "{not json");
    await expect(loadState(STATE_PATH)).rejects.toThrow();
  });
});

describe("resume helpers", () => {
  const state: PipelineState = {
    lastUpdated: "now",
    completedPhases: {
      "model-a": { phase1Passed: true, phase2Passed: true },
      "model-b": { discardedAt: "DISCARDED_PHASE1", phase1Passed: false },
    },
  };

  test("hasCompletedPhase1/2 reflect recorded booleans", () => {
    expect(hasCompletedPhase1(state, "model-a")).toBe(true);
    expect(hasCompletedPhase2(state, "model-a")).toBe(true);
    expect(hasCompletedPhase1(state, "model-b")).toBe(true);
    expect(hasCompletedPhase2(state, "model-b")).toBe(false);
  });

  test("hasCompletedPhase1/2 are false for unseen models", () => {
    expect(hasCompletedPhase1(state, "unknown")).toBe(false);
    expect(hasCompletedPhase2(state, "unknown")).toBe(false);
  });

  test("hasCompletedPhase3/4 reflect presence of recorded profiles/metrics", () => {
    const withProfile: PipelineState = {
      lastUpdated: "now",
      completedPhases: {
        "model-a": {
          phase3Profile: {
            modelKey: "model-a",
            quant: "Q4_K_M",
            verifiedGpuOffload: "max",
            kvCacheQuant: "Q8_0",
            maxRecommendedContext: 32768,
            ladderHistory: [],
          },
        },
      },
    };
    expect(hasCompletedPhase3(withProfile, "model-a")).toBe(true);
    expect(hasCompletedPhase3(withProfile, "model-b")).toBe(false);
    expect(hasCompletedPhase4(withProfile, "model-a")).toBe(false);
  });
});

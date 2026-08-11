import { describe, expect, test } from "bun:test";
import { buildMarkdownTable, generateMarkdownReport } from "../src/report";
import type { PipelineState } from "../src/types";

describe("buildMarkdownTable", () => {
  test("renders a header, separator, and one row per entry", () => {
    const table = buildMarkdownTable(["Model", "Score"], [["model-a", "9"], ["model-b", "7"]]);
    const lines = table.trim().split("\n");
    expect(lines[0]).toBe("| Model | Score |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| model-a | 9 |");
    expect(lines[3]).toBe("| model-b | 7 |");
  });
});

describe("generateMarkdownReport", () => {
  const state: PipelineState = {
    lastUpdated: "2026-08-10T12:00:00.000Z",
    completedPhases: {
      "model-a": {
        quant: "Q4_K_M",
        phase1Passed: true,
        phase2Passed: true,
        phase3Profile: {
          modelKey: "model-a",
          quant: "Q4_K_M",
          verifiedGpuOffload: "max",
          kvCacheQuant: "Q8_0",
          maxRecommendedContext: 32768,
          ladderHistory: [],
        },
        phase4Metrics: {
          modelKey: "model-a",
          passRatePercent: 86.666,
          syntaxErrorCount: 1,
          avgDecodeSpeed: 24.5,
          thermalDecayPercent: 3.2,
        },
      },
      "model-b": {
        phase1Passed: false,
        phase1TokPerSec: 3.2,
        discardedAt: "DISCARDED_PHASE1",
      },
    },
  };

  test("includes the generation timestamp", () => {
    const report = generateMarkdownReport(state);
    expect(report).toContain("2026-08-10T12:00:00.000Z");
  });

  test("renders a fully-tuned model's data across every column", () => {
    const report = generateMarkdownReport(state);
    expect(report).toContain("model-a");
    expect(report).toContain("32768");
    expect(report).toContain("max");
    expect(report).toContain("Q8_0");
    expect(report).toContain("86.7"); // rounded to 1 decimal
    expect(report).toContain("3.2");
  });

  test("shows the measured Phase 1 speed for a discarded model instead of a bare fail flag", () => {
    const report = generateMarkdownReport(state);
    expect(report).toContain("model-b");
    expect(report).toContain("Fail (3.2 tok/s)");
  });

  test("shows the model's currently-selected quant even though it can't be changed", () => {
    const report = generateMarkdownReport(state);
    const modelARow = report.split("\n").find((line) => line.startsWith("| model-a "));
    expect(modelARow).toContain("Q4_K_M");
  });

  test("shows a quant placeholder for a model discarded before any quant was recorded", () => {
    const noQuant: PipelineState = {
      lastUpdated: "now",
      completedPhases: { "model-unknown": { phase1Passed: false, phase1TokPerSec: 1 } },
    };
    const report = generateMarkdownReport(noQuant);
    const row = report.split("\n").find((line) => line.startsWith("| model-unknown "));
    expect(row).toContain("—");
  });

  test("shows the measured Phase 1 speed for a model that passed, not just for failures", () => {
    const report = generateMarkdownReport({
      lastUpdated: "now",
      completedPhases: { "model-fast": { phase1Passed: true, phase1TokPerSec: 42.1 } },
    });
    expect(report).toContain("Pass (42.1 tok/s)");
  });

  test("shows the Phase 2 failure reason inline when one is recorded", () => {
    const report = generateMarkdownReport({
      lastUpdated: "now",
      completedPhases: {
        "model-c": {
          phase1Passed: true,
          phase1TokPerSec: 20,
          phase2Passed: false,
          phase2Reason: "output did not contain valid JSON",
          discardedAt: "DISCARDED_PHASE2",
        },
      },
    });
    expect(report).toContain("Fail (output did not contain valid JSON)");
  });

  test("shows an Errors section and an Error cell for a model whose phase threw", () => {
    const report = generateMarkdownReport({
      lastUpdated: "now",
      completedPhases: {
        "model-crashes": {
          quant: "Q4_K_M",
          discardedAt: "ERRORED_PHASE1",
          errorMessage: "Engine protocol runtime llama-server exited before becoming healthy. exitCode=3221226505",
        },
      },
    });
    expect(report).toContain("## Errors");
    expect(report).toContain("model-crashes");
    expect(report).toContain("Phase 1");
    expect(report).toContain("exitCode=3221226505");
    expect(report).toContain("Error (see Errors section)");
  });

  test("has no Errors section when nothing errored", () => {
    const report = generateMarkdownReport(state);
    expect(report).not.toContain("## Errors");
  });

  test("uses a placeholder for phases that have not run yet", () => {
    const partial: PipelineState = {
      lastUpdated: "now",
      completedPhases: { "model-c": { phase1Passed: true } },
    };
    const report = generateMarkdownReport(partial);
    expect(report).toContain("model-c");
    expect(report).toContain("—");
  });

  test("produces a stable report for an empty pipeline state", () => {
    const empty: PipelineState = { lastUpdated: "now", completedPhases: {} };
    expect(() => generateMarkdownReport(empty)).not.toThrow();
    expect(generateMarkdownReport(empty)).toContain("No candidate models");
  });

  test("has no quantization-note callout when nothing warrants one", () => {
    const report = generateMarkdownReport(state);
    expect(report).not.toContain("Quantization Notes");
  });

  test("flags a model that ran close to its RAM/VRAM ceiling with a smaller-quant suggestion", () => {
    const tight: PipelineState = {
      lastUpdated: "now",
      completedPhases: {
        "model-tight": {
          phase1Passed: true,
          phase2Passed: true,
          phase3Profile: {
            modelKey: "model-tight",
            quant: "Q4_K_M",
            verifiedGpuOffload: "max",
            kvCacheQuant: "Q8_0",
            maxRecommendedContext: 8192,
            ladderHistory: [
              {
                contextLength: 8192,
                prefillTokPerSec: 400,
                decodeTokPerSec: 20,
                timeToFirstTokenMs: 100,
                snapshot: { ramUsedPercent: 88, ramUsedGB: 28, dedicatedVramFreeMB: 1200, sharedGpuMemoryMB: 0 },
                speedDropPercent: 0,
              },
            ],
          },
        },
      },
    };
    const report = generateMarkdownReport(tight);
    expect(report).toContain("Quantization Notes");
    expect(report).toContain("model-tight");
    expect(report).toContain("Q4_K_S");
    expect(report).toMatch(/RAM.*ceiling|ceiling.*RAM|close to its RAM/i);
  });

  test("flags a model with unused headroom with a larger-quant suggestion", () => {
    const loose: PipelineState = {
      lastUpdated: "now",
      completedPhases: {
        "model-loose": {
          phase1Passed: true,
          phase2Passed: true,
          phase3Profile: {
            modelKey: "model-loose",
            quant: "Q4_K_M",
            verifiedGpuOffload: "max",
            kvCacheQuant: "Q8_0",
            maxRecommendedContext: 8192,
            ladderHistory: [
              {
                contextLength: 8192,
                prefillTokPerSec: 400,
                decodeTokPerSec: 20,
                timeToFirstTokenMs: 100,
                snapshot: { ramUsedPercent: 15, ramUsedGB: 5, dedicatedVramFreeMB: 9000, sharedGpuMemoryMB: 0 },
                speedDropPercent: 0,
              },
            ],
          },
        },
      },
    };
    const report = generateMarkdownReport(loose);
    expect(report).toContain("Quantization Notes");
    expect(report).toContain("model-loose");
    expect(report).toContain("Q5_K_S");
    expect(report).toMatch(/headroom/i);
  });
});

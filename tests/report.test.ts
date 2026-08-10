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

  test("marks a Phase 1 discard clearly instead of blank cells", () => {
    const report = generateMarkdownReport(state);
    expect(report).toContain("model-b");
    expect(report).toMatch(/DISCARDED_PHASE1|Discarded.*Phase 1/i);
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
});

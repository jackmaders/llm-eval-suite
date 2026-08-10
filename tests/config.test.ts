import { describe, expect, test } from "bun:test";
import { parseLmsLsOutput, preflightCheck, validateModelsConfig } from "../src/config";
import type { CommandRunner } from "../src/subprocess";
import type { ModelConfig } from "../src/types";

describe("validateModelsConfig", () => {
  test("accepts a well-formed array", () => {
    const raw = [{ modelKey: "qwen2.5-coder-32b", quant: "Q4_K_M" }];
    expect(validateModelsConfig(raw)).toEqual(raw as ModelConfig[]);
  });

  test("rejects non-array input", () => {
    expect(() => validateModelsConfig({ modelKey: "x", quant: "y" })).toThrow();
  });

  test("rejects entries missing modelKey or quant", () => {
    expect(() => validateModelsConfig([{ modelKey: "x" }])).toThrow();
    expect(() => validateModelsConfig([{ quant: "Q4_K_M" }])).toThrow();
  });

  test("rejects entries with non-string fields", () => {
    expect(() => validateModelsConfig([{ modelKey: 1, quant: "Q4_K_M" }])).toThrow();
  });
});

describe("parseLmsLsOutput", () => {
  test("parses a JSON array of strings", () => {
    const raw = JSON.stringify(["model-a", "model-b"]);
    expect(parseLmsLsOutput(raw)).toEqual(["model-a", "model-b"]);
  });

  test("parses a JSON array of objects using path or modelKey", () => {
    const raw = JSON.stringify([{ path: "model-a" }, { modelKey: "model-b" }]);
    expect(parseLmsLsOutput(raw)).toEqual(["model-a", "model-b"]);
  });

  test("falls back to line-based parsing for non-JSON output", () => {
    const raw = "model-a\nmodel-b\n";
    expect(parseLmsLsOutput(raw)).toEqual(["model-a", "model-b"]);
  });

  test("returns an empty list for blank output", () => {
    expect(parseLmsLsOutput("   \n  ")).toEqual([]);
  });
});

describe("preflightCheck", () => {
  const models: ModelConfig[] = [
    { modelKey: "model-a", quant: "Q4_K_M" },
    { modelKey: "model-b", quant: "Q5_K_M" },
  ];

  function fakeRunner(stdout: string): CommandRunner {
    return {
      run: async () => ({ stdout, stderr: "", exitCode: 0 }),
    };
  }

  test("reports ok:true when all configured models are locally available", async () => {
    const runner = fakeRunner(JSON.stringify(["model-a", "model-b", "model-c"]));
    const result = await preflightCheck(models, runner);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("reports missing models when lms ls does not list them", async () => {
    const runner = fakeRunner(JSON.stringify(["model-a"]));
    const result = await preflightCheck(models, runner);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ modelKey: "model-b", quant: "Q5_K_M" }]);
  });

  test("propagates a non-zero exit code from lms ls as an error", async () => {
    const runner: CommandRunner = {
      run: async () => ({ stdout: "", stderr: "lms: command not found", exitCode: 127 }),
    };
    await expect(preflightCheck(models, runner)).rejects.toThrow(/lms ls/);
  });
});

import { describe, expect, test } from "bun:test";
import { hasRepetitionLoop, PHASE2_CONTEXT_LENGTH, runPhase2, validatePhase2Output } from "../src/phases/phase2";
import type { LmStudioClient } from "../src/apiClient";
import type { CommandRunner } from "../src/subprocess";
import type { ModelConfig } from "../src/types";

const model: ModelConfig = { modelKey: "model-a", quant: "Q4_K_M" };

const validToolCall = {
  tool: "extract_function_signature",
  functionName: "add",
  parameters: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
  returnType: "number",
};

describe("validatePhase2Output", () => {
  test("accepts a well-formed JSON tool call", () => {
    const result = validatePhase2Output(JSON.stringify(validToolCall));
    expect(result.passed).toBe(true);
    expect(result.parsedJson).toEqual(validToolCall);
  });

  test("accepts JSON embedded in surrounding prose", () => {
    const result = validatePhase2Output(`Here is the result:\n${JSON.stringify(validToolCall)}\nDone.`);
    expect(result.passed).toBe(true);
  });

  test("rejects unparsable output", () => {
    const result = validatePhase2Output("not json at all");
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/JSON/i);
  });

  test("rejects JSON missing required schema fields", () => {
    const result = validatePhase2Output(JSON.stringify({ tool: "extract_function_signature" }));
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/schema/i);
  });

  test("rejects output containing an infinite repetition loop", () => {
    const looping = `${JSON.stringify(validToolCall)} ${"the same the same the same the same the same ".repeat(1)}`;
    const result = validatePhase2Output(looping);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/repetition/i);
  });
});

describe("hasRepetitionLoop", () => {
  test("detects a short phrase repeating many times consecutively", () => {
    expect(hasRepetitionLoop("the cat sat the cat sat the cat sat the cat sat")).toBe(true);
  });

  test("does not flag normal prose", () => {
    expect(hasRepetitionLoop("The quick brown fox jumps over the lazy dog near the river bank.")).toBe(false);
  });
});

function fakeRunner(): CommandRunner {
  return { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
}

function fakeClient(text: string): LmStudioClient {
  return {
    completion: async () => ({
      text,
      promptTokens: 400,
      completionTokens: 40,
      timeToFirstTokenMs: 100,
      totalTimeMs: 2000,
      prefillTokPerSec: 400,
      decodeTokPerSec: 20,
    }),
  } as unknown as LmStudioClient;
}

describe("runPhase2", () => {
  test("loads at 8192 context and passes a valid response", async () => {
    const runner = fakeRunner();
    const spy: string[] = [];
    const spiedRunner: CommandRunner = {
      run: async (cmd, args) => {
        spy.push(args.join(" "));
        return runner.run(cmd, args);
      },
    };
    const client = fakeClient(JSON.stringify(validToolCall));
    const result = await runPhase2(model, { runner: spiedRunner, client });

    expect(result.passed).toBe(true);
    // spy[0] is the pre-load `lms unload --all` loadModel() now always issues.
    expect(spy[1]).toContain(String(PHASE2_CONTEXT_LENGTH));
  });

  test("discards a model producing malformed JSON", async () => {
    const client = fakeClient("garbage output {{{");
    const result = await runPhase2(model, { runner: fakeRunner(), client });
    expect(result.passed).toBe(false);
  });
});

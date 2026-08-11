import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("regression: picks the final JSON object over an earlier brace-laden reasoning preamble", () => {
    // Reasoning-tuned models commonly think out loud before answering, and
    // that reasoning can itself contain example/draft JSON with braces. The
    // naive "first { to last }" extraction used to span from the reasoning's
    // opening brace all the way to the real answer's closing brace, producing
    // an unparsable concatenation and a false "invalid JSON" failure even
    // though a good answer was present.
    const output = `Let me think about this. A draft might look like {"example": "not this one"} but let me format it correctly.

${JSON.stringify(validToolCall)}`;
    const result = validatePhase2Output(output);
    expect(result.passed).toBe(true);
    expect(result.parsedJson).toEqual(validToolCall);
  });

  test("still fails on genuinely truncated/incomplete JSON", () => {
    const truncated = JSON.stringify(validToolCall).slice(0, -10);
    const result = validatePhase2Output(truncated);
    expect(result.passed).toBe(false);
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
  const failureLogDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(failureLogDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  function makeFailureLogDir(): string {
    const dir = join(tmpdir(), `llm-eval-suite-phase2-failures-${crypto.randomUUID()}`);
    failureLogDirs.push(dir);
    return dir;
  }

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

  test("saves the raw response to a failure log file when validation fails", async () => {
    const failureLogDir = makeFailureLogDir();
    const client = fakeClient("garbage output {{{");
    const result = await runPhase2(model, { runner: fakeRunner(), client, failureLogDir });

    expect(result.passed).toBe(false);
    const files = await readdir(failureLogDir);
    expect(files).toHaveLength(1);
    const content = await readFile(join(failureLogDir, files[0]!), "utf-8");
    expect(content).toContain("model-a");
    expect(content).toContain("garbage output {{{");
    expect(content).toContain(result.reason ?? "");
  });

  test("does not write a failure log on success", async () => {
    const failureLogDir = makeFailureLogDir();
    const client = fakeClient(JSON.stringify(validToolCall));
    await runPhase2(model, { runner: fakeRunner(), client, failureLogDir });

    await expect(readdir(failureLogDir)).rejects.toThrow();
  });
});

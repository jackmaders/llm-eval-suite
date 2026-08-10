import { describe, expect, test } from "bun:test";
import { PHASE1_CONTEXT_LENGTH, PHASE1_MIN_TOK_PER_SEC, runPhase1 } from "../src/phases/phase1";
import type { LmStudioClient } from "../src/apiClient";
import type { CommandRunner } from "../src/subprocess";
import type { ModelConfig } from "../src/types";

const model: ModelConfig = { modelKey: "model-a", quant: "Q4_K_M" };

function fakeRunner(): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    runner: {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
}

function fakeClient(decodeTokPerSec: number): LmStudioClient {
  return {
    completion: async () => ({
      text: "hello there",
      promptTokens: 5,
      completionTokens: 10,
      timeToFirstTokenMs: 50,
      totalTimeMs: 1000,
      prefillTokPerSec: 100,
      decodeTokPerSec,
    }),
  } as unknown as LmStudioClient;
}

describe("runPhase1", () => {
  test("passes a model generating at or above 10 tok/sec", async () => {
    const { runner, calls } = fakeRunner();
    const client = fakeClient(15.5);
    const result = await runPhase1(model, { runner, client });

    expect(result.passed).toBe(true);
    expect(result.tokPerSec).toBe(15.5);
    expect(result.modelKey).toBe("model-a");
    expect(calls[0]).toEqual({
      cmd: "lms",
      args: ["load", "model-a", "--context-length", String(PHASE1_CONTEXT_LENGTH), "--yes"],
    });
  });

  test("discards a model generating below 10 tok/sec", async () => {
    const { runner } = fakeRunner();
    const client = fakeClient(9.99);
    const result = await runPhase1(model, { runner, client });
    expect(result.passed).toBe(false);
  });

  test("treats exactly the threshold as passing", async () => {
    const { runner } = fakeRunner();
    const client = fakeClient(PHASE1_MIN_TOK_PER_SEC);
    const result = await runPhase1(model, { runner, client });
    expect(result.passed).toBe(true);
  });

  test("propagates load failures instead of silently marking a discard", async () => {
    const runner: CommandRunner = {
      run: async () => ({ stdout: "", stderr: "gguf load error", exitCode: 1 }),
    };
    const client = fakeClient(20);
    await expect(runPhase1(model, { runner, client })).rejects.toThrow(/gguf load error/);
  });
});

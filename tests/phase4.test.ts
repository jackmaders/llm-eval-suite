import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDER_TIMEOUT_MS,
  buildAiderArgs,
  buildMiniPolyglotSubset,
  detectSyntaxError,
  runPhase4,
  sanitizeWorkspaceName,
} from "../src/phases/phase4";
import type { LmStudioClient } from "../src/apiClient";
import type { CommandRunner } from "../src/subprocess";
import type { ModelConfig } from "../src/types";

const model: ModelConfig = { modelKey: "qwen2.5-coder/32b-instruct", quant: "Q4_K_M" };
const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeWorkspaceRoot(): string {
  const dir = join(tmpdir(), `llm-eval-suite-phase4-${crypto.randomUUID()}`);
  testRoots.push(dir);
  return dir;
}

describe("buildMiniPolyglotSubset", () => {
  test("produces exactly 15 problems with unique ids and file names", () => {
    const problems = buildMiniPolyglotSubset();
    expect(problems).toHaveLength(15);
    expect(new Set(problems.map((p) => p.id)).size).toBe(15);
    expect(new Set(problems.map((p) => p.fileName)).size).toBe(15);
    for (const p of problems) {
      expect(p.buggyCode.length).toBeGreaterThan(0);
      expect(p.testCommand.length).toBeGreaterThan(0);
    }
  });
});

describe("sanitizeWorkspaceName", () => {
  test("strips characters unsafe for a directory name", () => {
    expect(sanitizeWorkspaceName("qwen2.5-coder/32b-instruct")).toBe("qwen2.5-coder_32b-instruct");
  });
});

describe("detectSyntaxError", () => {
  test("flags common syntax error signatures across languages", () => {
    expect(detectSyntaxError("SyntaxError: Unexpected token }")).toBe(true);
    expect(detectSyntaxError("error[E0433]: failed to resolve")).toBe(true);
    expect(detectSyntaxError("IndentationError: unexpected indent")).toBe(true);
  });

  test("does not flag a normal assertion failure", () => {
    expect(detectSyntaxError("AssertionError: expected 4 to equal 5")).toBe(false);
  });
});

describe("buildAiderArgs", () => {
  test("targets the local LM Studio endpoint and lists every problem file", () => {
    const problems = buildMiniPolyglotSubset();
    const args = buildAiderArgs(problems, "http://127.0.0.1:1234/v1", model.modelKey);
    expect(args).toContain("--openai-api-base");
    expect(args).toContain("http://127.0.0.1:1234/v1");
    for (const p of problems) expect(args).toContain(p.fileName);
  });
});

describe("runPhase4", () => {
  test("initializes an isolated git workspace, runs aider, and grades tests", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const commandCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args, opts) => {
        commandCalls.push({ cmd, args, cwd: opts?.cwd });
        if (cmd === "aider") return { stdout: "applied edits", stderr: "", exitCode: 0 };
        // Every seeded test command "passes" in this scenario.
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    let completionCalls = 0;
    const client: Pick<LmStudioClient, "completion"> = {
      completion: async () => {
        completionCalls++;
        return {
          text: "hi",
          promptTokens: 5,
          completionTokens: 10,
          timeToFirstTokenMs: 50,
          totalTimeMs: 1000,
          prefillTokPerSec: 100,
          decodeTokPerSec: completionCalls === 1 ? 20 : 18,
        };
      },
    };

    const metrics = await runPhase4(model, { runner, client, workspaceRoot });

    expect(metrics.passRatePercent).toBe(100);
    expect(metrics.syntaxErrorCount).toBe(0);
    expect(completionCalls).toBe(2);
    expect(metrics.thermalDecayPercent).toBeCloseTo(10, 5);

    const gitInitCall = commandCalls.find((c) => c.cmd === "git" && c.args[0] === "init");
    expect(gitInitCall).toBeDefined();
    const aiderCall = commandCalls.find((c) => c.cmd === "aider");
    expect(aiderCall?.cwd).toBe(metrics.workspaceDir);
  });

  test("passes the 15-minute timeout through to the aider subprocess", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    let aiderTimeout: number | undefined;
    const runner: CommandRunner = {
      run: async (cmd, args, opts) => {
        if (cmd === "aider") aiderTimeout = opts?.timeoutMs;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    const client: Pick<LmStudioClient, "completion"> = {
      completion: async () => ({
        text: "hi",
        promptTokens: 5,
        completionTokens: 10,
        timeToFirstTokenMs: 50,
        totalTimeMs: 1000,
        prefillTokPerSec: 100,
        decodeTokPerSec: 20,
      }),
    };

    await runPhase4(model, { runner, client, workspaceRoot });
    expect(aiderTimeout).toBe(AIDER_TIMEOUT_MS);
  });

  test("still grades tests when the aider subprocess times out", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const runner: CommandRunner = {
      run: async (cmd) => {
        if (cmd === "aider") throw new Error(`Command "aider" timed out after ${AIDER_TIMEOUT_MS}ms`);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    const client: Pick<LmStudioClient, "completion"> = {
      completion: async () => ({
        text: "hi",
        promptTokens: 5,
        completionTokens: 10,
        timeToFirstTokenMs: 50,
        totalTimeMs: 1000,
        prefillTokPerSec: 100,
        decodeTokPerSec: 20,
      }),
    };

    const metrics = await runPhase4(model, { runner, client, workspaceRoot });
    expect(metrics.passRatePercent).toBe(100);
  });

  test("counts syntax-error test failures separately from ordinary failures", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    let call = 0;
    const runner: CommandRunner = {
      run: async (cmd) => {
        if (cmd === "aider") return { stdout: "ok", stderr: "", exitCode: 0 };
        if (cmd === "git") return { stdout: "", stderr: "", exitCode: 0 };
        call++;
        if (call === 1) return { stdout: "", stderr: "SyntaxError: Unexpected token", exitCode: 1 };
        if (call === 2) return { stdout: "", stderr: "AssertionError: expected 1 to equal 2", exitCode: 1 };
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    const client: Pick<LmStudioClient, "completion"> = {
      completion: async () => ({
        text: "hi",
        promptTokens: 5,
        completionTokens: 10,
        timeToFirstTokenMs: 50,
        totalTimeMs: 1000,
        prefillTokPerSec: 100,
        decodeTokPerSec: 20,
      }),
    };

    const metrics = await runPhase4(model, { runner, client, workspaceRoot });
    expect(metrics.syntaxErrorCount).toBe(1);
    expect(metrics.passRatePercent).toBeCloseTo((13 / 15) * 100, 5);
  });
});

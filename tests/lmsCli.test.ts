import { describe, expect, test } from "bun:test";
import { createLoadCapabilities, loadModel, unloadAll } from "../src/lmsCli";
import type { CommandRunner } from "../src/subprocess";

describe("loadModel", () => {
  test("unloads whatever's currently loaded before issuing the new load", async () => {
    // Regression test: loading the same modelKey twice in a row (e.g. Phase 1
    // then Phase 2 at a different context length) without an intervening
    // unload could leave `lms` serving requests against a stale or
    // differently-configured instance instead of the one just requested —
    // reported as "the script is loading a different version of the same
    // model when running phase 2".
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    await loadModel(runner, "qwen2.5-coder-32b", { contextLength: 8192, kvCacheQuant: "Q8_0" });

    expect(calls[0]).toEqual({ cmd: "lms", args: ["unload", "--all"] });
    expect(calls[1]?.cmd).toBe("lms");
    expect(calls[1]?.args).toEqual([
      "load",
      "qwen2.5-coder-32b",
      "--context-length",
      "8192",
      "--kv-cache-quant",
      "Q8_0",
      "--yes",
    ]);
  });

  test("includes --gpu when a specific offload layer count is given", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    await loadModel(runner, "model-a", { contextLength: 4096, gpuOffloadLayers: 32 });
    expect(calls[1]?.args).toContain("--gpu");
    expect(calls[1]?.args).toContain("32");
  });

  test("still issues the load even when the pre-emptive unload fails", async () => {
    // A failed defensive unload (e.g. nothing was loaded yet) must not block
    // the actual load — only a failure of the load itself should throw.
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === "unload") return { stdout: "", stderr: "no models loaded", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    await loadModel(runner, "model-a", { contextLength: 4096 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0]).toBe("load");
  });

  test("throws when lms load itself exits non-zero", async () => {
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        if (args[0] === "unload") return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "out of memory", exitCode: 1 };
      },
    };
    await expect(loadModel(runner, "model-a", { contextLength: 4096 })).rejects.toThrow(/out of memory/);
  });

  test("retries without --kv-cache-quant when the installed lms version doesn't support it", async () => {
    // Reported: `lms load ... failed (exit 1): error: unknown option '--kv-cache-quant'`
    // on an older lms CLI that predates the flag — this should degrade
    // gracefully (load without KV cache quantization) instead of aborting
    // the entire run over one unsupported flag.
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let loadAttempts = 0;
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === "unload") return { stdout: "", stderr: "", exitCode: 0 };
        loadAttempts++;
        if (loadAttempts === 1) {
          return { stdout: "", stderr: "error: unknown option '--kv-cache-quant'", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    await loadModel(runner, "model-a", { contextLength: 8192, kvCacheQuant: "Q8_0" });

    expect(loadAttempts).toBe(2);
    const loadCalls = calls.filter((c) => c.args[0] === "load");
    expect(loadCalls[0]?.args).toContain("--kv-cache-quant");
    expect(loadCalls[1]?.args).not.toContain("--kv-cache-quant");
    expect(loadCalls[1]?.args).not.toContain("Q8_0");
  });

  test("does not retry (and still throws) when the load failure is unrelated to --kv-cache-quant", async () => {
    let loadAttempts = 0;
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        if (args[0] === "unload") return { stdout: "", stderr: "", exitCode: 0 };
        loadAttempts++;
        return { stdout: "", stderr: "out of memory", exitCode: 1 };
      },
    };

    await expect(
      loadModel(runner, "model-a", { contextLength: 8192, kvCacheQuant: "Q8_0" }),
    ).rejects.toThrow(/out of memory/);
    expect(loadAttempts).toBe(1);
  });

  test("does not retry when the load failed for another unknown-option flag", async () => {
    let loadAttempts = 0;
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        if (args[0] === "unload") return { stdout: "", stderr: "", exitCode: 0 };
        loadAttempts++;
        return { stdout: "", stderr: "error: unknown option '--gpu'", exitCode: 1 };
      },
    };

    await expect(
      loadModel(runner, "model-a", { contextLength: 8192, kvCacheQuant: "Q8_0" }),
    ).rejects.toThrow(/unknown option '--gpu'/);
    expect(loadAttempts).toBe(1);
  });

  test("remembers --kv-cache-quant is unsupported across calls sharing the same capabilities object", async () => {
    // Reported: Phase 3's offload/context ladder loops call loadModel many
    // times per model — without remembering the result of the first
    // unsupported-flag detection, every single one of those repeats the same
    // doomed attempt-then-retry cycle (seen as 7+ identical warnings for one
    // model in one run), each one an extra unnecessary unload/load cycle.
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let loadAttempts = 0;
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === "unload") return { stdout: "", stderr: "", exitCode: 0 };
        loadAttempts++;
        // Only the very first load attempt ever sees --kv-cache-quant; if a
        // second one arrives, the "remember" behavior isn't working.
        if (args.includes("--kv-cache-quant") && loadAttempts > 1) {
          throw new Error("test setup violated: --kv-cache-quant attempted more than once");
        }
        if (args.includes("--kv-cache-quant")) {
          return { stdout: "", stderr: "error: unknown option '--kv-cache-quant'", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const capabilities = createLoadCapabilities();
    await loadModel(runner, "model-a", { contextLength: 8192, kvCacheQuant: "Q8_0" }, capabilities);
    await loadModel(runner, "model-a", { contextLength: 16384, kvCacheQuant: "Q8_0" }, capabilities);
    await loadModel(runner, "model-b", { contextLength: 8192, kvCacheQuant: "Q8_0" }, capabilities);

    // First call: unload, load-with-flag (fails), load-without-flag (succeeds) = 3.
    // Each subsequent call already knows to skip the flag: unload, load = 2 each.
    expect(calls).toHaveLength(3 + 2 + 2);
    const loadCallsWithFlag = calls.filter((c) => c.args.includes("--kv-cache-quant"));
    expect(loadCallsWithFlag).toHaveLength(1);
  });

  test("without a shared capabilities object, each call re-attempts --kv-cache-quant independently", async () => {
    let attemptsWithFlag = 0;
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        if (args[0] === "unload") return { stdout: "", stderr: "", exitCode: 0 };
        if (args.includes("--kv-cache-quant")) {
          attemptsWithFlag++;
          return { stdout: "", stderr: "error: unknown option '--kv-cache-quant'", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    await loadModel(runner, "model-a", { contextLength: 8192, kvCacheQuant: "Q8_0" });
    await loadModel(runner, "model-a", { contextLength: 16384, kvCacheQuant: "Q8_0" });

    expect(attemptsWithFlag).toBe(2);
  });
});

describe("unloadAll", () => {
  test("runs lms unload --all", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    await unloadAll(runner);
    expect(calls[0]).toEqual({ cmd: "lms", args: ["unload", "--all"] });
  });

  test("throws when unload fails", async () => {
    const runner: CommandRunner = {
      run: async () => ({ stdout: "", stderr: "no models loaded", exitCode: 1 }),
    };
    // Spec doesn't require unload to be fatal when nothing is loaded, but a
    // genuine non-zero exit should still surface to the caller.
    await expect(unloadAll(runner)).rejects.toThrow(/no models loaded/);
  });
});

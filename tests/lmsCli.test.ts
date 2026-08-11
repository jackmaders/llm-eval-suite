import { describe, expect, test } from "bun:test";
import { loadModel, unloadAll } from "../src/lmsCli";
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

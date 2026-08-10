import { describe, expect, test } from "bun:test";
import { discoverModels, extractQuant, parseLmsLsModels } from "../src/config";
import type { CommandRunner } from "../src/subprocess";

describe("extractQuant", () => {
  test("extracts common k-quant tokens from a model path", () => {
    expect(extractQuant("TheBloke/Mistral-7B-Instruct-v0.2-GGUF/mistral-7b-instruct-v0.2.Q4_K_M.gguf")).toBe(
      "Q4_K_M",
    );
    expect(extractQuant("some/path/model.Q8_0.gguf")).toBe("Q8_0");
    expect(extractQuant("some/path/model.q5_k_s.gguf")).toBe("Q5_K_S");
  });

  test("extracts full-precision and legacy tokens", () => {
    expect(extractQuant("model.F16.gguf")).toBe("F16");
    expect(extractQuant("model.BF16.gguf")).toBe("BF16");
    expect(extractQuant("model.IQ2_XXS.gguf")).toBe("IQ2_XXS");
  });

  test("falls back to \"unknown\" when no quant token is present", () => {
    expect(extractQuant("some/path/without-a-quant-token")).toBe("unknown");
  });
});

describe("parseLmsLsModels", () => {
  test("parses a JSON array of plain path strings, deriving quant from each path", () => {
    const raw = JSON.stringify([
      "publisher/model-a-GGUF/model-a.Q4_K_M.gguf",
      "publisher/model-b-GGUF/model-b.Q8_0.gguf",
    ]);
    expect(parseLmsLsModels(raw)).toEqual([
      { modelKey: "publisher/model-a-GGUF/model-a.Q4_K_M.gguf", quant: "Q4_K_M" },
      { modelKey: "publisher/model-b-GGUF/model-b.Q8_0.gguf", quant: "Q8_0" },
    ]);
  });

  test("prefers an explicit quantization field over one inferred from the path", () => {
    const raw = JSON.stringify([{ path: "publisher/model-a-GGUF/model-a.gguf", quantization: "Q4_K_M" }]);
    expect(parseLmsLsModels(raw)).toEqual([{ modelKey: "publisher/model-a-GGUF/model-a.gguf", quant: "Q4_K_M" }]);
  });

  test("falls back to modelKey field when path is absent", () => {
    const raw = JSON.stringify([{ modelKey: "model-a", quant: "Q5_K_M" }]);
    expect(parseLmsLsModels(raw)).toEqual([{ modelKey: "model-a", quant: "Q5_K_M" }]);
  });

  test("falls back to line-based parsing for non-JSON output", () => {
    const raw = "model-a.Q4_K_M.gguf\nmodel-b.Q8_0.gguf\n";
    expect(parseLmsLsModels(raw)).toEqual([
      { modelKey: "model-a.Q4_K_M.gguf", quant: "Q4_K_M" },
      { modelKey: "model-b.Q8_0.gguf", quant: "Q8_0" },
    ]);
  });

  test("returns an empty list for blank output", () => {
    expect(parseLmsLsModels("   \n  ")).toEqual([]);
  });

  test("flattens the real `--variants`-grouped shape into one entry per quantization", () => {
    // Trimmed from an actual `lms ls --json --variants` run: each top-level
    // entry groups a base model's summary under `model` alongside every
    // individually-downloaded quantization under `variants`.
    const raw = JSON.stringify([
      {
        model: {
          type: "llm",
          modelKey: "qwen/qwen3.6-27b",
          quantization: { name: "Q4_K_M", bits: 4 },
          variants: ["qwen/qwen3.6-27b@q4_k_m", "qwen/qwen3.6-27b@q6_k"],
          selectedVariant: "qwen/qwen3.6-27b@q4_k_m",
        },
        variants: [
          { type: "llm", modelKey: "qwen/qwen3.6-27b@q4_k_m", quantization: { name: "Q4_K_M", bits: 4 } },
          { type: "llm", modelKey: "qwen/qwen3.6-27b@q6_k", quantization: { name: "Q6_K", bits: 6 } },
        ],
      },
      {
        model: {
          type: "llm",
          modelKey: "mistralai/codestral-22b-v0.1",
          quantization: { name: "Q4_K_M", bits: 4 },
          variants: ["mistralai/codestral-22b-v0.1@q4_k_m"],
          selectedVariant: "mistralai/codestral-22b-v0.1@q4_k_m",
        },
        variants: [
          { type: "llm", modelKey: "mistralai/codestral-22b-v0.1@q4_k_m", quantization: { name: "Q4_K_M", bits: 4 } },
        ],
      },
    ]);

    expect(parseLmsLsModels(raw)).toEqual([
      { modelKey: "qwen/qwen3.6-27b@q4_k_m", quant: "Q4_K_M" },
      { modelKey: "qwen/qwen3.6-27b@q6_k", quant: "Q6_K" },
      { modelKey: "mistralai/codestral-22b-v0.1@q4_k_m", quant: "Q4_K_M" },
    ]);
  });

  test("throws on a recognized-JSON-but-unexpected shape instead of silently mangling it into text lines", () => {
    // Regression test: previously, any error while mapping a valid-but-odd
    // JSON shape was swallowed and the whole raw payload got re-parsed as
    // newline-separated text, producing one giant garbage "model key" out of
    // the entire JSON blob — which was then handed straight to `lms load`.
    const raw = JSON.stringify([{ nothingRecognizable: true }]);
    expect(() => parseLmsLsModels(raw)).toThrow(/unrecognized/i);
  });
});

describe("discoverModels", () => {
  test("expands quantization variants via `lms ls --json --variants`", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return {
          stdout: JSON.stringify([
            {
              model: { modelKey: "publisher/model-a-GGUF", quantization: { name: "Q4_K_M", bits: 4 } },
              variants: [
                { modelKey: "publisher/model-a-GGUF@q4_k_m", quantization: { name: "Q4_K_M", bits: 4 } },
                { modelKey: "publisher/model-a-GGUF@q8_0", quantization: { name: "Q8_0", bits: 8 } },
              ],
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const models = await discoverModels(runner);
    expect(calls[0]).toEqual({ cmd: "lms", args: ["ls", "--json", "--variants"] });
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ modelKey: "publisher/model-a-GGUF@q4_k_m", quant: "Q4_K_M" });
  });

  test("propagates a non-zero exit code from lms ls as an error", async () => {
    const runner: CommandRunner = {
      run: async () => ({ stdout: "", stderr: "lms: command not found", exitCode: 127 }),
    };
    await expect(discoverModels(runner)).rejects.toThrow(/lms ls/);
  });

  test("returns an empty list rather than throwing when nothing is downloaded", async () => {
    const runner: CommandRunner = { run: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }) };
    expect(await discoverModels(runner)).toEqual([]);
  });
});

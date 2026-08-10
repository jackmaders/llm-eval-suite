// Live model discovery against LM Studio's local model store. Candidates are
// no longer hand-typed in a static file — every downloaded GGUF quantization
// variant `lms ls --json --variants` reports becomes a candidate automatically.

import type { CommandRunner } from "./subprocess";
import type { ModelConfig } from "./types";

/**
 * Matches common llama.cpp/GGUF quantization tokens (Q4_K_M, Q5_K_S, Q8_0,
 * Q2_K, IQ2_XXS, F16, BF16, ...) embedded in a model path or key, so a quant
 * can be inferred even when LM Studio doesn't report one as a separate field.
 */
const QUANT_PATTERN = /\b(IQ\d_[A-Z0-9]+|Q\d(?:_[A-Z0-9]+){1,2}|F(?:16|32)|BF16)\b/i;

/** Infers a GGUF quantization label from a model path/key. "unknown" if none is found. */
export function extractQuant(identifier: string): string {
  const match = identifier.match(QUANT_PATTERN);
  return match ? match[1]!.toUpperCase() : "unknown";
}

/**
 * Parses the stdout of `lms ls --json --variants` into ModelConfig[]. Tolerates
 * a plain JSON array of path strings, an array of objects carrying `path` or
 * `modelKey` (and optionally an explicit `quantization`/`quant` field), and
 * falls back to line-based text parsing if the output isn't JSON at all.
 */
export function parseLmsLsModels(raw: string): ModelConfig[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item): ModelConfig => {
        if (typeof item === "string") {
          return { modelKey: item, quant: extractQuant(item) };
        }
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const modelKey = typeof obj.path === "string" ? obj.path : typeof obj.modelKey === "string" ? obj.modelKey : undefined;
          if (!modelKey) throw new Error("unrecognized entry shape");
          const explicitQuant = typeof obj.quantization === "string" ? obj.quantization : typeof obj.quant === "string" ? obj.quant : undefined;
          return { modelKey, quant: explicitQuant ?? extractQuant(modelKey) };
        }
        throw new Error("unrecognized entry shape");
      });
    }
  } catch {
    // Fall through to line-based parsing below.
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ modelKey: line, quant: extractQuant(line) }));
}

/**
 * Discovers every locally-downloaded model+quantization variant by shelling
 * out to `lms ls --json --variants` (the `--variants` flag is what expands
 * each base model into its individually-downloaded quantizations). Throws if
 * the `lms` CLI itself fails, since that means no run can proceed at all.
 */
export async function discoverModels(runner: CommandRunner): Promise<ModelConfig[]> {
  const result = await runner.run("lms", ["ls", "--json", "--variants"]);
  if (result.exitCode !== 0) {
    throw new Error(`\`lms ls\` failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
  return parseLmsLsModels(result.stdout);
}

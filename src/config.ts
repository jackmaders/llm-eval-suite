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

/** Reads a modelKey + quant off a single "leaf" model object, in whatever shape it's in. */
function readModelEntry(obj: Record<string, unknown>): ModelConfig | undefined {
  const modelKey = typeof obj.modelKey === "string" ? obj.modelKey : typeof obj.path === "string" ? obj.path : undefined;
  if (!modelKey) return undefined;

  const quantization = obj.quantization;
  let quant: string | undefined;
  if (typeof quantization === "string") {
    quant = quantization;
  } else if (quantization && typeof quantization === "object" && typeof (quantization as Record<string, unknown>).name === "string") {
    quant = (quantization as Record<string, unknown>).name as string;
  } else if (typeof obj.quant === "string") {
    quant = obj.quant;
  }

  return { modelKey, quant: quant ?? extractQuant(modelKey) };
}

/** Flattens one `lms ls --json --variants` array entry into its evaluable model(s). */
function readListEntry(item: unknown): ModelConfig[] {
  if (typeof item === "string") {
    return [{ modelKey: item, quant: extractQuant(item) }];
  }
  if (!item || typeof item !== "object") {
    throw new Error(`unrecognized \`lms ls\` entry: ${JSON.stringify(item)}`);
  }

  const obj = item as Record<string, unknown>;

  // `--variants` groups by base model as { model: {...}, variants: [...] }.
  // Each entry in `variants` carries its own fully-qualified, individually
  // loadable "modelKey@quant" — that's what actually needs to be evaluated,
  // not the ungrouped `model` summary (which lacks the quant suffix `lms
  // load` needs to pick a specific variant).
  if (Array.isArray(obj.variants)) {
    const models = obj.variants.flatMap((variant) => {
      if (!variant || typeof variant !== "object") return [];
      const model = readModelEntry(variant as Record<string, unknown>);
      return model ? [model] : [];
    });
    if (models.length > 0) return models;
  }

  const inner = obj.model && typeof obj.model === "object" ? (obj.model as Record<string, unknown>) : obj;
  const model = readModelEntry(inner);
  if (!model) throw new Error(`unrecognized \`lms ls\` entry: ${JSON.stringify(item)}`);
  return [model];
}

/**
 * Parses the stdout of `lms ls --json --variants` into ModelConfig[]. Handles
 * both a flat array of model objects/paths and the `--variants`-grouped
 * `{ model, variants }` shape LM Studio actually emits, and falls back to
 * line-based text parsing only when the output isn't JSON at all — a
 * recognized-but-unexpected JSON shape throws instead of being silently
 * misread as a list of plain-text lines.
 */
export function parseLmsLsModels(raw: string): ModelConfig[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ modelKey: line, quant: extractQuant(line) }));
  }

  if (!Array.isArray(parsed)) {
    throw new Error("expected `lms ls --json` output to be a JSON array");
  }
  return parsed.flatMap(readListEntry);
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

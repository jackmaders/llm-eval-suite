// Live model discovery against LM Studio's local model store. Candidates are
// no longer hand-typed in a static file — every downloaded base model
// `lms ls --json --variants` reports becomes a candidate automatically.
//
// IMPORTANT: `lms load` and the `/api/v1/models/load` REST endpoint cannot
// target a specific quantization variant of a model — this is a confirmed,
// currently-open upstream limitation (lmstudio-ai/lmstudio-bug-tracker#1462).
// Both only accept a base model key and always resolve to whichever variant
// is currently marked "selected" for that model inside the LM Studio app,
// regardless of any "@quant" suffix passed in. So each base model can only
// contribute ONE evaluable candidate per run — the currently selected
// variant — even if several quantizations are downloaded locally.

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

/**
 * Parses the Hugging Face `owner/repo` and GGUF filename out of the
 * `indexedModelIdentifier` LM Studio reports for a variant, e.g.
 * `"mistralai/magistral-small-2509@lmstudio-community/Magistral-Small-2509-GGUF/Magistral-Small-2509-Q4_K_M.gguf"`
 * -> `{ repoId: "lmstudio-community/Magistral-Small-2509-GGUF", fileName: "Magistral-Small-2509-Q4_K_M.gguf" }`.
 * Returns undefined for anything that doesn't look like this shape (e.g. a
 * locally-imported model with no Hugging Face provenance) — used to look up
 * a model's full remote quantization catalog (see remoteQuants.ts).
 */
export function parseHfRepoFromIdentifier(identifier: string): { repoId: string; fileName: string } | undefined {
  const atIndex = identifier.lastIndexOf("@");
  const remainder = atIndex === -1 ? identifier : identifier.slice(atIndex + 1);
  const parts = remainder.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) return undefined;

  const fileName = parts[parts.length - 1]!;
  if (!fileName.toLowerCase().endsWith(".gguf")) return undefined;

  return { repoId: parts.slice(0, -1).join("/"), fileName };
}

/**
 * Reads the single loadable candidate out of one `lms ls --json --variants`
 * array entry. `--variants` groups each base model as `{ model, variants }`,
 * but only `model`'s own (unsuffixed) modelKey is ever accepted by `lms
 * load` — the individual `variants[].modelKey` "@quant" identifiers are
 * display-only (see the file header note). The grouped shape also carries
 * two things read here for later use (recommendation/remote-catalog
 * checks): every quantization already downloaded locally, and the Hugging
 * Face repo the currently-selected variant was published under.
 */
function readListEntry(item: unknown): ModelConfig {
  if (typeof item === "string") {
    return { modelKey: item, quant: extractQuant(item) };
  }
  if (!item || typeof item !== "object") {
    throw new Error(`unrecognized \`lms ls\` entry: ${JSON.stringify(item)}`);
  }

  const obj = item as Record<string, unknown>;
  const inner = obj.model && typeof obj.model === "object" ? (obj.model as Record<string, unknown>) : obj;
  const model = readModelEntry(inner);
  if (!model) throw new Error(`unrecognized \`lms ls\` entry: ${JSON.stringify(item)}`);

  const variants = Array.isArray(obj.variants) ? obj.variants : undefined;
  if (!variants) return model;

  const locallyAvailableQuants = variants
    .map((v) => (v && typeof v === "object" ? readModelEntry(v as Record<string, unknown>)?.quant : undefined))
    .filter((q): q is string => Boolean(q));
  if (locallyAvailableQuants.length > 0) model.locallyAvailableQuants = locallyAvailableQuants;

  const selectedVariant = typeof inner.selectedVariant === "string" ? inner.selectedVariant : undefined;
  const selectedVariantObj = selectedVariant
    ? variants.find((v) => v && typeof v === "object" && (v as Record<string, unknown>).modelKey === selectedVariant)
    : undefined;
  const identifier =
    selectedVariantObj && typeof selectedVariantObj === "object"
      ? (selectedVariantObj as Record<string, unknown>).indexedModelIdentifier
      : undefined;
  if (typeof identifier === "string") {
    const hf = parseHfRepoFromIdentifier(identifier);
    if (hf) model.hfRepoId = hf.repoId;
  }

  return model;
}

/**
 * Parses the stdout of `lms ls --json --variants` into ModelConfig[] — one
 * entry per base model, using whichever quantization is currently selected
 * for it. Falls back to line-based text parsing only when the output isn't
 * JSON at all; a recognized-but-unexpected JSON shape throws instead of
 * being silently misread as a list of plain-text lines.
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
  return parsed.map(readListEntry);
}

/**
 * Scans `lms ls --json --variants` output for base models with more than one
 * downloaded quantization, and returns one human-readable warning per such
 * model — since only its currently-selected variant can actually be
 * evaluated this run (see the file header note). Returns [] for shapes with
 * no `variants` grouping (nothing to warn about).
 */
export function findUnevaluatedVariantWarnings(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const warnings: string[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const variants = obj.variants;
    if (!Array.isArray(variants) || variants.length <= 1) continue;

    const modelObj = obj.model && typeof obj.model === "object" ? (obj.model as Record<string, unknown>) : obj;
    const baseKey = typeof modelObj.modelKey === "string" ? modelObj.modelKey : "unknown model";
    const selected = typeof modelObj.selectedVariant === "string" ? modelObj.selectedVariant : undefined;
    const quantNames = variants
      .map((v) => (v && typeof v === "object" ? readModelEntry(v as Record<string, unknown>)?.quant : undefined))
      .filter((q): q is string => Boolean(q));

    warnings.push(
      `"${baseKey}" has ${variants.length} downloaded quantizations (${quantNames.join(", ")}) but only the ` +
        `currently selected variant${selected ? ` ("${selected}")` : ""} can be evaluated this run — LM Studio's ` +
        `CLI/API cannot select a specific variant to load (lmstudio-ai/lmstudio-bug-tracker#1462). Switch the ` +
        `selected variant in LM Studio and re-run to evaluate the others.`,
    );
  }
  return warnings;
}

/**
 * Discovers every locally-downloaded base model by shelling out to
 * `lms ls --json --variants`, logging a warning for any model with
 * unevaluated quantization variants. Throws if the `lms` CLI itself fails,
 * since that means no run can proceed at all.
 */
export async function discoverModels(runner: CommandRunner): Promise<ModelConfig[]> {
  const result = await runner.run("lms", ["ls", "--json", "--variants"]);
  if (result.exitCode !== 0) {
    throw new Error(`\`lms ls\` failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
  for (const warning of findUnevaluatedVariantWarnings(result.stdout)) {
    console.warn(`WARNING: ${warning}`);
  }
  return parseLmsLsModels(result.stdout);
}

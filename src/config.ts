// Configuration loading (models.json) and pre-flight validation against `lms ls`.
// See spec: "1. Configuration & Pre-Flight Validation".

import type { CommandRunner } from "./subprocess";
import type { ModelConfig } from "./types";

export class ConfigValidationError extends Error {}

/** Validates that raw JSON parsed from models.json matches ModelConfig[]. */
export function validateModelsConfig(raw: unknown): ModelConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError("models.json must contain a JSON array of { modelKey, quant } entries");
  }

  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ConfigValidationError(`models.json[${index}] must be an object`);
    }
    const { modelKey, quant } = entry as Record<string, unknown>;
    if (typeof modelKey !== "string" || modelKey.length === 0) {
      throw new ConfigValidationError(`models.json[${index}].modelKey must be a non-empty string`);
    }
    if (typeof quant !== "string" || quant.length === 0) {
      throw new ConfigValidationError(`models.json[${index}].quant must be a non-empty string`);
    }
    return { modelKey, quant };
  });
}

/** Reads and validates a models.json file from disk. */
export async function readModelsConfig(path: string): Promise<ModelConfig[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigValidationError(`Config file not found: ${path}`);
  }
  const raw = await file.json();
  return validateModelsConfig(raw);
}

/**
 * Parses the stdout of `lms ls` into a flat list of available model identifiers.
 * Tolerates LM Studio's `--json` output (array of strings, or array of objects
 * carrying a `path` or `modelKey` field) as well as plain line-based text output.
 */
export function parseLmsLsOutput(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj.path === "string") return obj.path;
          if (typeof obj.modelKey === "string") return obj.modelKey;
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
    .filter((line) => line.length > 0);
}

export interface PreflightResult {
  ok: boolean;
  available: string[];
  missing: ModelConfig[];
}

/**
 * Verifies that every configured model is present in LM Studio's local model
 * store by shelling out to `lms ls --json`. Throws if the `lms` CLI itself fails
 * (e.g. not installed), since that indicates the whole run cannot proceed.
 */
export async function preflightCheck(models: ModelConfig[], runner: CommandRunner): Promise<PreflightResult> {
  const result = await runner.run("lms", ["ls", "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(`\`lms ls\` failed with exit code ${result.exitCode}: ${result.stderr}`);
  }

  const available = parseLmsLsOutput(result.stdout);
  const availableSet = new Set(available);
  const missing = models.filter((m) => !availableSet.has(m.modelKey));

  return { ok: missing.length === 0, available, missing };
}

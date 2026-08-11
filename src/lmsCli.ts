// Model lifecycle management via the `lms` CLI (load / unload). Distinct from
// apiClient.ts, which only talks to the already-loaded model's HTTP endpoint.
// See spec: "model management commands invoked via `lms load` and `lms unload --all`".

import type { CommandRunner } from "./subprocess";
import type { KvCacheQuant } from "./types";

export interface LoadModelOptions {
  contextLength: number;
  kvCacheQuant?: KvCacheQuant;
  gpuOffloadLayers?: number | "max";
}

/**
 * Remembers which `lms load` flags this CLI install has already been found
 * not to support, so repeated loadModel() calls (Phase 3's offload/context
 * ladder loops call it many times per model) don't each redo the same
 * doomed attempt-then-retry cycle — one extra unload/load cycle per attempt,
 * which is worth avoiding on its own merits (see the native-crash note in
 * phase3.ts). Share ONE instance across an entire run (created once by the
 * orchestrator) so the very first failure anywhere teaches every later call,
 * for every model, not just repeats within one model's own loads.
 */
export interface LoadCapabilities {
  kvCacheQuantSupported?: boolean;
}

export function createLoadCapabilities(): LoadCapabilities {
  return {};
}

async function runUnloadAll(runner: CommandRunner) {
  return runner.run("lms", ["unload", "--all"]);
}

function buildLoadArgs(modelKey: string, opts: LoadModelOptions): string[] {
  const args = ["load", modelKey, "--context-length", String(opts.contextLength)];
  if (opts.kvCacheQuant) {
    args.push("--kv-cache-quant", opts.kvCacheQuant);
  }
  if (opts.gpuOffloadLayers !== undefined) {
    args.push("--gpu", String(opts.gpuOffloadLayers));
  }
  // Unattended: never block waiting for an interactive confirmation prompt.
  args.push("--yes");
  return args;
}

/** True when stderr reports that `lms` doesn't recognize the given flag on this CLI version. */
function isUnknownOptionError(stderr: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`unknown option ['"]?${escaped}\\b`, "i").test(stderr);
}

export async function loadModel(
  runner: CommandRunner,
  modelKey: string,
  opts: LoadModelOptions,
  capabilities: LoadCapabilities = {},
): Promise<void> {
  // Unload whatever's currently loaded first. `lms load` on top of an
  // already-loaded model can stack a second instance alongside it — or leave
  // API requests resolving against whichever instance LM Studio picks —
  // instead of cleanly replacing it. Without this, calling loadModel twice
  // in a row for the same modelKey (e.g. Phase 1 then Phase 2 at a different
  // context length, or Phase 3's offload/context ladder loops) could end up
  // serving requests against a stale or differently-configured load rather
  // than the one just requested. Best effort: a failure here shouldn't block
  // the load that actually matters, so it's only logged, not thrown.
  const unloadResult = await runUnloadAll(runner);
  if (unloadResult.exitCode !== 0) {
    console.warn(
      `WARNING: \`lms unload --all\` before loading "${modelKey}" failed (exit ${unloadResult.exitCode}): ${unloadResult.stderr}`,
    );
  }

  // Already know this CLI doesn't support it — don't repeat the doomed attempt.
  const shouldTryKvCacheQuant = Boolean(opts.kvCacheQuant) && capabilities.kvCacheQuantSupported !== false;
  const attemptOpts = shouldTryKvCacheQuant ? opts : { ...opts, kvCacheQuant: undefined };

  let result = await runner.run("lms", buildLoadArgs(modelKey, attemptOpts));

  // Older `lms` CLI versions predate --kv-cache-quant and reject it outright
  // rather than ignoring it. Rather than aborting the whole run over one
  // unsupported flag, retry once without it — Q8_0 KV cache quantization
  // just won't be applied for this model on this LM Studio install — and
  // remember it for every later call sharing this capabilities object.
  if (shouldTryKvCacheQuant && result.exitCode !== 0 && isUnknownOptionError(result.stderr, "--kv-cache-quant")) {
    capabilities.kvCacheQuantSupported = false;
    console.warn(
      `WARNING: this \`lms\` CLI does not support --kv-cache-quant; skipping it for the rest of this run (starting with "${modelKey}").`,
    );
    result = await runner.run("lms", buildLoadArgs(modelKey, { ...opts, kvCacheQuant: undefined }));
  } else if (shouldTryKvCacheQuant && result.exitCode === 0) {
    capabilities.kvCacheQuantSupported = true;
  }

  if (result.exitCode !== 0) {
    throw new Error(`lms load ${modelKey} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

export async function unloadAll(runner: CommandRunner): Promise<void> {
  const result = await runUnloadAll(runner);
  if (result.exitCode !== 0) {
    throw new Error(`lms unload --all failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

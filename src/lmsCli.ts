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

async function runUnloadAll(runner: CommandRunner) {
  return runner.run("lms", ["unload", "--all"]);
}

export async function loadModel(runner: CommandRunner, modelKey: string, opts: LoadModelOptions): Promise<void> {
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

  const args = ["load", modelKey, "--context-length", String(opts.contextLength)];

  if (opts.kvCacheQuant) {
    args.push("--kv-cache-quant", opts.kvCacheQuant);
  }
  if (opts.gpuOffloadLayers !== undefined) {
    args.push("--gpu", String(opts.gpuOffloadLayers));
  }
  // Unattended: never block waiting for an interactive confirmation prompt.
  args.push("--yes");

  const result = await runner.run("lms", args);
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

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

export async function loadModel(runner: CommandRunner, modelKey: string, opts: LoadModelOptions): Promise<void> {
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
  const result = await runner.run("lms", ["unload", "--all"]);
  if (result.exitCode !== 0) {
    throw new Error(`lms unload --all failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

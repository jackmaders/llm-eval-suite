// Atomic pipeline state persistence + --resume helpers.
// See spec: "State Persistence" and user story 13.

import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompletedPhases, PipelineState } from "./types";

/** Reads the pipeline state file, or null if it doesn't exist yet. */
export async function loadState(path: string): Promise<PipelineState | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  // Let JSON parse errors propagate: a corrupt state file must not be silently
  // treated as "no prior progress", since that would re-run completed work
  // under the illusion of a clean --resume.
  return (await file.json()) as PipelineState;
}

/**
 * Writes state via write-then-rename so a crash mid-write never leaves a
 * truncated or partially-written data/.pipeline_state.json behind.
 */
export async function saveStateAtomic(path: string, state: PipelineState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Bun.write(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, path);
}

function phasesFor(state: PipelineState, modelKey: string): CompletedPhases | undefined {
  return state.completedPhases[modelKey];
}

export function hasCompletedPhase1(state: PipelineState, modelKey: string): boolean {
  return phasesFor(state, modelKey)?.phase1Passed !== undefined;
}

export function hasCompletedPhase2(state: PipelineState, modelKey: string): boolean {
  return phasesFor(state, modelKey)?.phase2Passed === true;
}

export function hasCompletedPhase3(state: PipelineState, modelKey: string): boolean {
  return phasesFor(state, modelKey)?.phase3Profile !== undefined;
}

export function hasCompletedPhase4(state: PipelineState, modelKey: string): boolean {
  return phasesFor(state, modelKey)?.phase4Metrics !== undefined;
}

/** Merges a partial phase result for a model into state, stamping lastUpdated. */
export function withPhaseUpdate(
  state: PipelineState,
  modelKey: string,
  update: Partial<CompletedPhases>,
  now: () => string = () => new Date().toISOString(),
): PipelineState {
  return {
    lastUpdated: now(),
    completedPhases: {
      ...state.completedPhases,
      [modelKey]: { ...state.completedPhases[modelKey], ...update },
    },
  };
}

export function emptyState(now: () => string = () => new Date().toISOString()): PipelineState {
  return { lastUpdated: now(), completedPhases: {} };
}

// Orchestrator: wires live model discovery and the four phases together
// against persisted state, honoring --resume. See spec "Pipeline Stage
// Logic" end-to-end and user stories 12-14.

import { join } from "node:path";
import type { LmStudioClient } from "./apiClient";
import { discoverModels } from "./config";
import type { HardwareProvider } from "./phases/phase3";
import { runPhase1 } from "./phases/phase1";
import { runPhase2 } from "./phases/phase2";
import { runPhase3 } from "./phases/phase3";
import { runPhase4 } from "./phases/phase4";
import { generateMarkdownReport } from "./report";
import { unloadAll } from "./lmsCli";
import {
  emptyState,
  hasCompletedPhase1,
  hasCompletedPhase2,
  hasCompletedPhase3,
  hasCompletedPhase4,
  loadState,
  saveStateAtomic,
  withPhaseUpdate,
} from "./state";
import type { CommandRunner } from "./subprocess";
import type { CompletedPhases, PipelineState } from "./types";

export interface OrchestratorDeps {
  statePath: string;
  dataDir: string;
  resume: boolean;
  runner: CommandRunner;
  client: Pick<LmStudioClient, "completion" | "healthCheck">;
  hardware: HardwareProvider;
  now?: () => string;
  baseUrl?: string;
  phase1?: typeof runPhase1;
  phase2?: typeof runPhase2;
  phase3?: typeof runPhase3;
  phase4?: typeof runPhase4;
}

export interface OrchestratorResult {
  state: PipelineState;
  reportPath: string;
  reportMarkdown: string;
}

function formatTimestampForFilename(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function currentPhases(state: PipelineState, modelKey: string): CompletedPhases {
  return state.completedPhases[modelKey] ?? {};
}

export async function runPipeline(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const phase1Fn = deps.phase1 ?? runPhase1;
  const phase2Fn = deps.phase2 ?? runPhase2;
  const phase3Fn = deps.phase3 ?? runPhase3;
  const phase4Fn = deps.phase4 ?? runPhase4;

  // User story 12: a dead/unbound LM Studio server must abort immediately,
  // before any model is loaded.
  await deps.client.healthCheck();

  // Candidates are discovered live from LM Studio's local model store rather
  // than typed into a static config file — every downloaded quantization
  // variant `lms ls --json --variants` reports is evaluated.
  const models = await discoverModels(deps.runner);
  if (models.length === 0) {
    throw new Error(
      "`lms ls` reports no downloaded models. Download at least one GGUF model in LM Studio before running the suite.",
    );
  }

  let state: PipelineState = deps.resume ? ((await loadState(deps.statePath)) ?? emptyState(now)) : emptyState(now);

  for (const model of models) {
    let phases = currentPhases(state, model.modelKey);

    if (deps.resume && (phases.discardedAt || hasCompletedPhase4(state, model.modelKey))) {
      continue;
    }

    // Phase 1: High-Speed Ping Filter
    if (!(deps.resume && hasCompletedPhase1(state, model.modelKey))) {
      const result = await phase1Fn(model, { runner: deps.runner, client: deps.client });
      state = withPhaseUpdate(state, model.modelKey, { phase1Passed: result.passed }, now);
      await saveStateAtomic(deps.statePath, state);
    }
    phases = currentPhases(state, model.modelKey);
    if (!phases.phase1Passed) {
      state = withPhaseUpdate(state, model.modelKey, { discardedAt: "DISCARDED_PHASE1" }, now);
      await saveStateAtomic(deps.statePath, state);
      await unloadAll(deps.runner);
      continue;
    }

    // Phase 2: Capability & Sanity Filter
    if (!(deps.resume && hasCompletedPhase2(state, model.modelKey))) {
      const result = await phase2Fn(model, { runner: deps.runner, client: deps.client });
      state = withPhaseUpdate(state, model.modelKey, { phase2Passed: result.passed }, now);
      await saveStateAtomic(deps.statePath, state);
    }
    phases = currentPhases(state, model.modelKey);
    if (!phases.phase2Passed) {
      state = withPhaseUpdate(state, model.modelKey, { discardedAt: "DISCARDED_PHASE2" }, now);
      await saveStateAtomic(deps.statePath, state);
      await unloadAll(deps.runner);
      continue;
    }

    // Phase 3: Stage-Gate Hyperparameter & Context Tuner
    if (!(deps.resume && hasCompletedPhase3(state, model.modelKey))) {
      const profile = await phase3Fn(model, { runner: deps.runner, client: deps.client, hardware: deps.hardware });
      state = withPhaseUpdate(state, model.modelKey, { phase3Profile: profile }, now);
      await saveStateAtomic(deps.statePath, state);
    }

    // Phase 4: Standardized Aider Refactoring Benchmark
    if (!(deps.resume && hasCompletedPhase4(state, model.modelKey))) {
      const metrics = await phase4Fn(model, {
        runner: deps.runner,
        client: deps.client,
        workspaceRoot: deps.dataDir,
        baseUrl: deps.baseUrl,
      });
      state = withPhaseUpdate(state, model.modelKey, { phase4Metrics: metrics }, now);
      await saveStateAtomic(deps.statePath, state);
    }

    await unloadAll(deps.runner);
  }

  const reportMarkdown = generateMarkdownReport(state);
  const reportPath = join(deps.dataDir, `report_${formatTimestampForFilename(state.lastUpdated)}.md`);
  await Bun.write(reportPath, reportMarkdown);

  return { state, reportPath, reportMarkdown };
}

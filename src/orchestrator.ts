// Orchestrator: wires live model discovery and the four phases together
// against persisted state, honoring --resume and --phases. See spec
// "Pipeline Stage Logic" end-to-end and user stories 12-14.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LmStudioClient } from "./apiClient";
import { discoverModels } from "./config";
import type { HardwareProvider } from "./phases/phase3";
import { PHASE1_MIN_TOK_PER_SEC, runPhase1 } from "./phases/phase1";
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

export type PhaseNumber = 1 | 2 | 3 | 4;
export const ALL_PHASES: ReadonlySet<PhaseNumber> = new Set([1, 2, 3, 4]);

export interface OrchestratorDeps {
  statePath: string;
  dataDir: string;
  resume: boolean;
  /** Which phases to actually run this invocation. Defaults to all four (ALL_PHASES). */
  phases?: ReadonlySet<PhaseNumber>;
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

/**
 * Parses a `--phases=1,2,4`-style CLI argument into a phase set. Returns
 * ALL_PHASES when the flag is absent. Throws on an empty list or any value
 * outside 1-4, since silently ignoring a typo would just look like every
 * model got discarded for no reason (the exact confusion this flag is meant
 * to help debug around).
 */
export function parsePhasesFlag(args: string[]): ReadonlySet<PhaseNumber> {
  const flag = args.find((a) => a.startsWith("--phases="));
  if (!flag) return ALL_PHASES;

  const raw = flag.slice("--phases=".length);
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (values.length === 0) {
    throw new Error('--phases requires at least one phase number, e.g. --phases=1,2');
  }

  const phases = new Set<PhaseNumber>();
  for (const value of values) {
    const n = Number(value);
    if (!ALL_PHASES.has(n as PhaseNumber)) {
      throw new Error(`Invalid --phases value "${value}" — each phase must be one of 1, 2, 3, 4`);
    }
    phases.add(n as PhaseNumber);
  }
  return phases;
}

function formatTimestampForFilename(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function currentPhases(state: PipelineState, modelKey: string): CompletedPhases {
  return state.completedPhases[modelKey] ?? {};
}

/**
 * Every phase runs to completion for one model before moving to the next, so
 * logs lead with the model name — scanning down the console should read as
 * one model's whole story at a time, not phase numbers interleaved across
 * different models.
 */
function logPhase(modelKey: string, phase: string, detail: string): void {
  console.log(`${modelKey} — ${phase}: ${detail}`);
}

export async function runPipeline(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const phases = deps.phases ?? ALL_PHASES;
  const phase1Fn = deps.phase1 ?? runPhase1;
  const phase2Fn = deps.phase2 ?? runPhase2;
  const phase3Fn = deps.phase3 ?? runPhase3;
  const phase4Fn = deps.phase4 ?? runPhase4;

  // data/ is gitignored rather than checked in, so create it on demand
  // instead of assuming it already exists.
  await mkdir(deps.dataDir, { recursive: true });

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
    let modelPhases = currentPhases(state, model.modelKey);

    if (deps.resume && (modelPhases.discardedAt || hasCompletedPhase4(state, model.modelKey))) {
      continue;
    }

    console.log(`\n=== ${model.modelKey} ===`);

    // Phase 1: High-Speed Ping Filter. Skipped entirely (no run, no discard
    // gate) when 1 isn't in the requested phase set — --phases lets you
    // isolate a single phase (e.g. to see its raw numbers) without the
    // pipeline treating an un-run earlier phase as a failure.
    if (phases.has(1)) {
      if (!(deps.resume && hasCompletedPhase1(state, model.modelKey))) {
        const result = await phase1Fn(model, { runner: deps.runner, client: deps.client });
        logPhase(
          model.modelKey,
          "Phase 1",
          `${result.tokPerSec.toFixed(2)} tok/sec (need >= ${PHASE1_MIN_TOK_PER_SEC} tok/sec) — ${result.passed ? "PASS" : "FAIL"}`,
        );
        state = withPhaseUpdate(
          state,
          model.modelKey,
          { phase1Passed: result.passed, phase1TokPerSec: result.tokPerSec },
          now,
        );
        await saveStateAtomic(deps.statePath, state);
      }
      modelPhases = currentPhases(state, model.modelKey);
      if (!modelPhases.phase1Passed) {
        state = withPhaseUpdate(state, model.modelKey, { discardedAt: "DISCARDED_PHASE1" }, now);
        await saveStateAtomic(deps.statePath, state);
        await unloadAll(deps.runner);
        continue;
      }
    }

    // Phase 2: Capability & Sanity Filter
    if (phases.has(2)) {
      if (!(deps.resume && hasCompletedPhase2(state, model.modelKey))) {
        const result = await phase2Fn(model, {
          runner: deps.runner,
          client: deps.client,
          failureLogDir: join(deps.dataDir, "phase2-failures"),
        });
        logPhase(model.modelKey, "Phase 2", result.passed ? "PASS" : `FAIL — ${result.reason ?? "unknown reason"}`);
        if (!result.passed) {
          console.log(`${model.modelKey} — raw Phase 2 response saved to ${join(deps.dataDir, "phase2-failures")}`);
        }
        state = withPhaseUpdate(
          state,
          model.modelKey,
          { phase2Passed: result.passed, phase2Reason: result.reason },
          now,
        );
        await saveStateAtomic(deps.statePath, state);
      }
      modelPhases = currentPhases(state, model.modelKey);
      if (!modelPhases.phase2Passed) {
        state = withPhaseUpdate(state, model.modelKey, { discardedAt: "DISCARDED_PHASE2" }, now);
        await saveStateAtomic(deps.statePath, state);
        await unloadAll(deps.runner);
        continue;
      }
    }

    // Phase 3: Stage-Gate Hyperparameter & Context Tuner
    if (phases.has(3) && !(deps.resume && hasCompletedPhase3(state, model.modelKey))) {
      const profile = await phase3Fn(model, { runner: deps.runner, client: deps.client, hardware: deps.hardware });
      logPhase(
        model.modelKey,
        "Phase 3",
        `max context ${profile.maxRecommendedContext}, GPU offload ${profile.verifiedGpuOffload}, KV cache ${profile.kvCacheQuant}`,
      );
      state = withPhaseUpdate(state, model.modelKey, { phase3Profile: profile }, now);
      await saveStateAtomic(deps.statePath, state);
    }

    // Phase 4: Standardized Aider Refactoring Benchmark
    if (phases.has(4) && !(deps.resume && hasCompletedPhase4(state, model.modelKey))) {
      const metrics = await phase4Fn(model, {
        runner: deps.runner,
        client: deps.client,
        workspaceRoot: deps.dataDir,
        baseUrl: deps.baseUrl,
      });
      logPhase(
        model.modelKey,
        "Phase 4",
        `${metrics.passRatePercent.toFixed(1)}% pass rate, ${metrics.syntaxErrorCount} syntax errors, ` +
          `decode ${metrics.avgDecodeSpeed.toFixed(1)} tok/s (decay ${metrics.thermalDecayPercent.toFixed(1)}%)`,
      );
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

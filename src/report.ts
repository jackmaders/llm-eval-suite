// Markdown comparison report generation. See spec section "5. Phase 4" outputs
// and user story 14. Pure formatting over PipelineState — no I/O here so it
// stays trivially testable; index.ts/orchestrator.ts own writing the file.

import { recommendQuantChange } from "./recommendation";
import type { CompletedPhases, PipelineState } from "./types";

const PLACEHOLDER = "—";

export function buildMarkdownTable(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, separatorLine, ...rowLines].join("\n");
}

function round1(n: number): string {
  return n.toFixed(1);
}

/** Short table-cell label for a quant recommendation; "—" when none applies. */
function quantNoteLabel(profile: CompletedPhases["phase3Profile"]): string {
  if (!profile) return PLACEHOLDER;
  const rec = recommendQuantChange(profile);
  if (!rec) return PLACEHOLDER;
  const arrow = rec.direction === "more-compression" ? "⬇" : "⬆";
  return rec.suggestedQuant ? `${arrow} try ${rec.suggestedQuant}` : `${arrow} ${rec.direction}`;
}

function isErroredAt(phases: CompletedPhases, phaseNum: 1 | 2): boolean {
  return phases.discardedAt === `ERRORED_PHASE${phaseNum}`;
}

/**
 * Always surfaces the measured tok/sec alongside pass/fail, not just on
 * failure — the whole point is to make it possible to tell "actually slow"
 * apart from "the measurement pipeline is broken" at a glance, without
 * digging through logs.
 */
function phase1Cell(phases: CompletedPhases): string {
  if (isErroredAt(phases, 1)) return "Error (see Errors section)";
  if (phases.phase1Passed === undefined) return PLACEHOLDER;
  const speed = phases.phase1TokPerSec !== undefined ? `${round1(phases.phase1TokPerSec)} tok/s` : PLACEHOLDER;
  return `${phases.phase1Passed ? "Pass" : "Fail"} (${speed})`;
}

function phase2Cell(phases: CompletedPhases): string {
  if (isErroredAt(phases, 2)) return "Error (see Errors section)";
  if (phases.phase2Passed === undefined) return PLACEHOLDER;
  if (phases.phase2Passed) return "Pass";
  return phases.phase2Reason ? `Fail (${phases.phase2Reason})` : "Fail";
}

function renderRow(modelKey: string, phases: CompletedPhases): string[] {
  const profile = phases.phase3Profile;
  const metrics = phases.phase4Metrics;

  return [
    modelKey,
    phases.quant ?? PLACEHOLDER,
    phase1Cell(phases),
    phase2Cell(phases),
    profile ? String(profile.maxRecommendedContext) : PLACEHOLDER,
    profile ? profile.verifiedGpuOffload : PLACEHOLDER,
    profile ? profile.kvCacheQuant : PLACEHOLDER,
    quantNoteLabel(profile),
    metrics ? `${round1(metrics.passRatePercent)}%` : PLACEHOLDER,
    metrics ? `${round1(metrics.avgDecodeSpeed)} tok/s (decay ${round1(metrics.thermalDecayPercent)}%)` : PLACEHOLDER,
  ];
}

/** Full-sentence quantization-note callouts for the section below the table. */
function renderQuantizationNotes(modelKeys: string[], completedPhases: PipelineState["completedPhases"]): string[] {
  const notes = modelKeys.flatMap((modelKey) => {
    const profile = completedPhases[modelKey]?.phase3Profile;
    if (!profile) return [];
    const rec = recommendQuantChange(profile);
    if (!rec) return [];
    const suggestion = rec.suggestedQuant ? ` Try ${rec.suggestedQuant} instead of ${profile.quant}.` : "";
    return [`- **${modelKey}**: ${rec.reason}${suggestion}`];
  });

  if (notes.length === 0) return [];
  return ["", "## Quantization Notes", "", ...notes];
}

/**
 * Lists every model whose evaluation stopped because a phase itself threw
 * (most commonly LM Studio's engine crashing on that specific model) rather
 * than returning a normal pass/fail — distinct from Quantization Notes,
 * which is about a model that completed evaluation but might do better at a
 * different quant.
 */
function renderErrorsSection(modelKeys: string[], completedPhases: PipelineState["completedPhases"]): string[] {
  const errors = modelKeys.flatMap((modelKey) => {
    const phases = completedPhases[modelKey];
    const discardedAt = phases?.discardedAt;
    if (!discardedAt?.startsWith("ERRORED_PHASE")) return [];
    const phaseNum = discardedAt.slice("ERRORED_PHASE".length);
    return [`- **${modelKey}** (Phase ${phaseNum}): ${phases?.errorMessage ?? "unknown error"}`];
  });

  if (errors.length === 0) return [];
  return ["", "## Errors", "", ...errors];
}

/** Renders the full comparison report written to data/report_<timestamp>.md. */
export function generateMarkdownReport(state: PipelineState): string {
  const modelKeys = Object.keys(state.completedPhases);
  const lines: string[] = [
    "# LLM Eval Suite — Comparison Report",
    "",
    `Generated: ${state.lastUpdated}`,
    "",
  ];

  if (modelKeys.length === 0) {
    lines.push("No candidate models were evaluated in this run.");
    return lines.join("\n");
  }

  const headers = [
    "Model",
    "Quant",
    "Phase 1 (Speed)",
    "Phase 2 (Sanity)",
    "Max Context",
    "GPU Offload",
    "KV Cache",
    "Quant Note",
    "Aider Pass Rate",
    "Decode Speed",
  ];
  const rows = modelKeys.map((modelKey) => renderRow(modelKey, state.completedPhases[modelKey] ?? {}));

  lines.push(buildMarkdownTable(headers, rows));
  lines.push("");
  lines.push(
    "_Max Context reflects the last context-ladder step that did not trip a guardrail " +
      "(system RAM ≥ 90%, shared GPU memory ≥ 300MB, or ≥ 15% decode-speed regression vs. the 8k baseline). " +
      "Quant is whichever variant is currently selected for that model in LM Studio — this suite cannot switch " +
      "it (lmstudio-ai/lmstudio-bug-tracker#1462); see the Quant Note column/section below for what to try instead._",
  );
  lines.push(...renderQuantizationNotes(modelKeys, state.completedPhases));
  lines.push(...renderErrorsSection(modelKeys, state.completedPhases));

  return lines.join("\n");
}

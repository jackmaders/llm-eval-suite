// Markdown comparison report generation. See spec section "5. Phase 4" outputs
// and user story 14. Pure formatting over PipelineState — no I/O here so it
// stays trivially testable; index.ts/orchestrator.ts own writing the file.

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

function renderRow(modelKey: string, phases: CompletedPhases): string[] {
  if (phases.discardedAt) {
    const stage = phases.discardedAt === "DISCARDED_PHASE1" ? "Phase 1" : "Phase 2";
    return [modelKey, `Discarded (${stage})`, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER];
  }

  const phase1 = phases.phase1Passed === undefined ? PLACEHOLDER : phases.phase1Passed ? "Pass" : "Fail";
  const phase2 = phases.phase2Passed === undefined ? PLACEHOLDER : phases.phase2Passed ? "Pass" : "Fail";
  const profile = phases.phase3Profile;
  const metrics = phases.phase4Metrics;

  return [
    modelKey,
    phase1,
    phase2,
    profile ? String(profile.maxRecommendedContext) : PLACEHOLDER,
    profile ? profile.verifiedGpuOffload : PLACEHOLDER,
    profile ? profile.kvCacheQuant : PLACEHOLDER,
    metrics ? `${round1(metrics.passRatePercent)}%` : PLACEHOLDER,
    metrics ? `${round1(metrics.avgDecodeSpeed)} tok/s (decay ${round1(metrics.thermalDecayPercent)}%)` : PLACEHOLDER,
  ];
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
    "Phase 1 (Speed)",
    "Phase 2 (Sanity)",
    "Max Context",
    "GPU Offload",
    "KV Cache",
    "Aider Pass Rate",
    "Decode Speed",
  ];
  const rows = modelKeys.map((modelKey) => renderRow(modelKey, state.completedPhases[modelKey] ?? {}));

  lines.push(buildMarkdownTable(headers, rows));
  lines.push("");
  lines.push(
    "_Max Context reflects the last context-ladder step that did not trip a guardrail " +
      "(system RAM ≥ 90%, shared GPU memory ≥ 300MB, or ≥ 15% decode-speed regression vs. the 8k baseline)._",
  );

  return lines.join("\n");
}

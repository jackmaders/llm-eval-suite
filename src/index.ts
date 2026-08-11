#!/usr/bin/env bun
// CLI entry point. See spec: "Execution Command: bun run src/index.ts (or
// bun run src/index.ts --resume)".

import { join } from "node:path";
import { LmStudioClient, ServerCrashError } from "./apiClient";
import { getHardwareSnapshot } from "./hardware";
import { parsePhasesFlag, runPipeline } from "./orchestrator";
import { BunCommandRunner } from "./subprocess";

const DATA_DIR = join(import.meta.dir, "..", "data");
const STATE_PATH = join(DATA_DIR, ".pipeline_state.json");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const checkRemoteQuants = args.includes("--check-remote-quants");

  const runner = new BunCommandRunner();
  const client = new LmStudioClient();
  const hardware = { getSnapshot: () => getHardwareSnapshot(runner) };

  try {
    const phases = parsePhasesFlag(args);
    console.log(`llm-eval-suite starting${resume ? " (resuming prior run)" : ""}...`);
    console.log(`Running phase(s): ${[...phases].sort().join(", ")}`);
    if (checkRemoteQuants) {
      console.log("Will check Hugging Face for downloadable quants behind any recommendation (--check-remote-quants).");
    }
    console.log("Discovering candidate models via `lms ls --json --variants`...");

    const { reportPath, state } = await runPipeline({
      statePath: STATE_PATH,
      dataDir: DATA_DIR,
      resume,
      phases,
      checkRemoteQuants,
      runner,
      client,
      hardware,
    });

    const evaluated = Object.keys(state.completedPhases).length;
    const errored = Object.values(state.completedPhases).filter((p) => p.discardedAt?.startsWith("ERRORED_PHASE")).length;
    console.log(`Done. Evaluated ${evaluated} model(s)${errored > 0 ? ` (${errored} errored — see the report's Errors section)` : ""}.`);
    console.log(`Report written to ${reportPath}`);
  } catch (err) {
    if (err instanceof ServerCrashError) {
      console.error(`FATAL: LM Studio server is unreachable — aborting the run to avoid corrupting state.`);
      console.error(err.message);
      process.exit(2);
    }
    console.error("FATAL:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();

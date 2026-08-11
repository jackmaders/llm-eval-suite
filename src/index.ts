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

  const runner = new BunCommandRunner();
  const client = new LmStudioClient();
  const hardware = { getSnapshot: () => getHardwareSnapshot(runner) };

  try {
    const phases = parsePhasesFlag(args);
    console.log(`llm-eval-suite starting${resume ? " (resuming prior run)" : ""}...`);
    console.log(`Running phase(s): ${[...phases].sort().join(", ")}`);
    console.log("Discovering candidate models via `lms ls --json --variants`...");

    const { reportPath, state } = await runPipeline({
      statePath: STATE_PATH,
      dataDir: DATA_DIR,
      resume,
      phases,
      runner,
      client,
      hardware,
    });

    const evaluated = Object.keys(state.completedPhases).length;
    console.log(`Done. Evaluated ${evaluated} model(s).`);
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

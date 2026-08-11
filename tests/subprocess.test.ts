import { describe, expect, test } from "bun:test";
import { BunCommandRunner } from "../src/subprocess";

describe("BunCommandRunner", () => {
  test("closes stdin so a spawned process never blocks waiting for interactive input", async () => {
    // Regression: every process this suite spawns (lms, powershell.exe,
    // aider, git) is meant to run fully unattended. Without an explicit
    // stdin setting, Bun.spawn defaults to inheriting our own terminal's —
    // so a spawned process that unexpectedly waits on a confirmation prompt
    // sees a live, interactive TTY and genuinely blocks forever waiting for
    // a keypress instead of failing fast (reported: aider appeared to hang
    // during Phase 4 with no way to tell why).
    //
    // `cat` with no arguments reads from stdin until EOF. If stdin is
    // properly closed (not inherited/left open), it gets EOF immediately and
    // exits right away; if stdin were left open, this would hang until the
    // timeout below fires — the same failure mode reported in production.
    const runner = new BunCommandRunner();
    const result = await runner.run("cat", [], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

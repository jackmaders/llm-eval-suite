// Subprocess seam: every external process invocation (lms, powershell.exe, aider) goes
// through this single interface so tests can substitute a fake runner instead of
// spawning real OS processes.

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<CommandResult>;
}

/** Real implementation backed by Bun.spawn. Not exercised in unit tests. */
export class BunCommandRunner implements CommandRunner {
  async run(cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<CommandResult> {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      // Every process this suite spawns (lms, powershell.exe, aider, git) is
      // meant to run fully unattended. Without this, stdin defaults to
      // inheriting our own terminal's — meaning a spawned process that
      // unexpectedly waits on a confirmation prompt sees a live, interactive
      // TTY and genuinely blocks forever waiting for a keypress that will
      // never come, instead of failing fast. Reported: aider appeared to
      // hang during Phase 4 with no way to tell why.
      stdin: "ignore",
    });

    const timeoutMs = opts?.timeoutMs;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (timer) clearTimeout(timer);

    if (timedOut) {
      throw new Error(`Command "${cmd} ${args.join(" ")}" timed out after ${timeoutMs}ms`);
    }

    return { stdout, stderr, exitCode };
  }
}

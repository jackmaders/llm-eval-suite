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

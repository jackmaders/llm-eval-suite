// Subprocess seam: every external process invocation (lms, powershell.exe, aider) goes
// through this single interface so tests can substitute a fake runner instead of
// spawning real OS processes.

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunOptions {
  timeoutMs?: number;
  cwd?: string;
  /**
   * Echo stdout/stderr to our own process's stdout/stderr live, as the
   * subprocess produces it, in addition to still buffering it for the
   * returned CommandResult. Off by default — most callers (lms ls, lms
   * load, the PowerShell hardware snapshot) parse the buffered result and
   * would only get noisier logs from also streaming it. Turn it on for
   * long-running, interactively-styled tools like aider, where otherwise
   * nothing is visible between the "running aider..." log line and either
   * completion or the 15-minute timeout.
   */
  streamOutput?: boolean;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: CommandRunOptions): Promise<CommandResult>;
}

/** Real implementation backed by Bun.spawn. Not exercised in unit tests. */
export class BunCommandRunner implements CommandRunner {
  async run(cmd: string, args: string[], opts?: CommandRunOptions): Promise<CommandResult> {
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
      readAll(proc.stdout, opts?.streamOutput ? (chunk) => process.stdout.write(chunk) : undefined),
      readAll(proc.stderr, opts?.streamOutput ? (chunk) => process.stderr.write(chunk) : undefined),
    ]);
    const exitCode = await proc.exited;
    if (timer) clearTimeout(timer);

    if (timedOut) {
      throw new Error(`Command "${cmd} ${args.join(" ")}" timed out after ${timeoutMs}ms`);
    }

    return { stdout, stderr, exitCode };
  }
}

/** Reads a subprocess stream to completion, optionally echoing each chunk as it arrives. */
async function readAll(stream: ReadableStream<Uint8Array>, onChunk?: (text: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    full += text;
    onChunk?.(text);
  }
  return full;
}

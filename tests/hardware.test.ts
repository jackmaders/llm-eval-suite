import { describe, expect, test } from "bun:test";
import { buildHardwareSnapshotScript, getHardwareSnapshot, parseHardwareSnapshotJson } from "../src/hardware";
import type { CommandRunner } from "../src/subprocess";

describe("parseHardwareSnapshotJson", () => {
  test("parses a well-formed PowerShell JSON payload", () => {
    const raw = JSON.stringify({
      ramUsedPercent: 62.5,
      ramUsedGB: 20,
      dedicatedVramFreeMB: 12000,
      sharedGpuMemoryMB: 50,
    });
    expect(parseHardwareSnapshotJson(raw)).toEqual({
      ramUsedPercent: 62.5,
      ramUsedGB: 20,
      dedicatedVramFreeMB: 12000,
      sharedGpuMemoryMB: 50,
    });
  });

  test("tolerates surrounding PowerShell noise around the JSON object", () => {
    const raw = `WARNING: some noise\n{"ramUsedPercent":10,"ramUsedGB":3.2,"dedicatedVramFreeMB":15000,"sharedGpuMemoryMB":0}\n`;
    expect(parseHardwareSnapshotJson(raw)).toEqual({
      ramUsedPercent: 10,
      ramUsedGB: 3.2,
      dedicatedVramFreeMB: 15000,
      sharedGpuMemoryMB: 0,
    });
  });

  test("throws when required fields are missing", () => {
    expect(() => parseHardwareSnapshotJson(JSON.stringify({ ramUsedPercent: 1 }))).toThrow();
  });

  test("throws on unparsable output", () => {
    expect(() => parseHardwareSnapshotJson("not json at all")).toThrow();
  });
});

describe("buildHardwareSnapshotScript", () => {
  // Regression tests: PowerShell paths embedded in a JS template literal need
  // their backslashes doubled (\\) to survive as single literal backslashes —
  // a single \ isn't a recognized JS escape, so JS silently drops it, leaving
  // whatever letter followed (\S -> S, \C -> C, ...). This exact mistake in
  // the registry path made the earlier 4GB-VRAM-cap fix a no-op: the mangled
  // path ("HKLM:SYSTEMCurrentControlSetControlClass{...}") never resolved,
  // Get-ChildItem silently found nothing (-ErrorAction SilentlyContinue), and
  // the script fell straight back to the original broken AdapterRAM query —
  // with no test catching it, since nothing asserted on the script's content.
  test("the registry path for VRAM size has real single backslashes, not stripped or doubled", () => {
    const script = buildHardwareSnapshotScript();
    expect(script).toContain(
      "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}",
    );
    // The exact mangled form the JS-escaping bug produced — must never reappear.
    expect(script).not.toContain("HKLM:SYSTEMCurrentControlSetControlClass");
  });

  test("the GPU Process Memory counter paths have real single backslashes", () => {
    const script = buildHardwareSnapshotScript();
    expect(script).toContain("\\GPU Process Memory(*)\\Dedicated Usage");
    expect(script).toContain("\\GPU Process Memory(*)\\Shared Usage");
  });

  test("scopes GPU usage to the inference engine's own process, not the whole system", () => {
    // Regression: GPU Adapter Memory(*) sums usage across every process on
    // the machine (confirmed on real hardware: it included the Windows
    // kernel process and 30+ ordinary desktop apps), making free VRAM
    // wildly unreliable. Must query GPU Process Memory scoped to the engine
    // process, not the system-wide GPU Adapter Memory counters.
    const script = buildHardwareSnapshotScript();
    expect(script).toContain("Get-Process -Name '*llama*'");
    // "GPU Adapter Memory" may still appear in an explanatory comment about
    // why it's no longer queried — the important thing is no Get-Counter
    // call actually reads from that (system-wide) counter category anymore.
    expect(script).not.toContain("Get-Counter '\\GPU Adapter Memory");
  });
});

describe("getHardwareSnapshot", () => {
  test("invokes powershell.exe and returns the parsed snapshot", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return {
          stdout: JSON.stringify({
            ramUsedPercent: 45,
            ramUsedGB: 14.4,
            dedicatedVramFreeMB: 13500,
            sharedGpuMemoryMB: 0,
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const snapshot = await getHardwareSnapshot(runner);
    expect(snapshot.ramUsedPercent).toBe(45);
    expect(calls[0]?.cmd).toBe("powershell.exe");
  });

  test("throws when powershell.exe exits non-zero", async () => {
    const runner: CommandRunner = {
      run: async () => ({ stdout: "", stderr: "access denied", exitCode: 1 }),
    };
    await expect(getHardwareSnapshot(runner)).rejects.toThrow(/powershell/i);
  });
});

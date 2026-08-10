import { describe, expect, test } from "bun:test";
import { getHardwareSnapshot, parseHardwareSnapshotJson } from "../src/hardware";
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

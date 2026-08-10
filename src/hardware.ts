// Hardware telemetry layer: discrete (non-polling) snapshots of system RAM and GPU
// memory pressure, taken via PowerShell. See spec: "Hardware Telemetry Layer" and
// user story 8 (discrete snapshots rather than continuous background polling).

import type { CommandRunner } from "./subprocess";
import type { HardwareSnapshot } from "./types";

/**
 * PowerShell script that samples Win32_OperatingSystem for system RAM and the
 * `GPU Adapter Memory` performance counters for dedicated/shared GPU memory, then
 * emits a single-line JSON object matching HardwareSnapshot. Built as a function
 * (rather than a module-level constant) so it stays easy to unit-test in isolation
 * from the string itself.
 */
export function buildHardwareSnapshotScript(): string {
  return `
$os = Get-CimInstance Win32_OperatingSystem
$totalKB = $os.TotalVisibleMemorySize
$freeKB = $os.FreePhysicalMemory
$usedKB = $totalKB - $freeKB
$ramUsedPercent = [math]::Round(($usedKB / $totalKB) * 100, 2)
$ramUsedGB = [math]::Round($usedKB / 1MB, 2)

$dedicated = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples |
  Measure-Object -Property CookedValue -Sum
$shared = (Get-Counter '\\GPU Adapter Memory(*)\\Shared Usage').CounterSamples |
  Measure-Object -Property CookedValue -Sum

$dedicatedUsedMB = [math]::Round($dedicated.Sum / 1MB, 2)
$sharedGpuMemoryMB = [math]::Round($shared.Sum / 1MB, 2)

# Dedicated VRAM total is read from the adapter's AdapterRAM (bytes) via CIM.
$vramTotalMB = (Get-CimInstance Win32_VideoController | Measure-Object -Property AdapterRAM -Sum).Sum / 1MB
$dedicatedVramFreeMB = [math]::Round($vramTotalMB - $dedicatedUsedMB, 2)

$result = @{
  ramUsedPercent = $ramUsedPercent
  ramUsedGB = $ramUsedGB
  dedicatedVramFreeMB = $dedicatedVramFreeMB
  sharedGpuMemoryMB = $sharedGpuMemoryMB
}
$result | ConvertTo-Json -Compress
`.trim();
}

/**
 * Parses the JSON payload emitted by buildHardwareSnapshotScript(). PowerShell can
 * emit warnings/progress text on stdout ahead of the JSON, so this scans for the
 * last JSON object in the output rather than parsing the whole string directly.
 */
export function parseHardwareSnapshotJson(raw: string): HardwareSnapshot {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not locate a JSON object in PowerShell output: ${raw.slice(0, 200)}`);
  }

  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  const fields: Array<keyof HardwareSnapshot> = [
    "ramUsedPercent",
    "ramUsedGB",
    "dedicatedVramFreeMB",
    "sharedGpuMemoryMB",
  ];
  for (const field of fields) {
    if (typeof parsed[field] !== "number") {
      throw new Error(`Hardware snapshot JSON missing numeric field "${field}": ${match[0]}`);
    }
  }

  return {
    ramUsedPercent: parsed.ramUsedPercent as number,
    ramUsedGB: parsed.ramUsedGB as number,
    dedicatedVramFreeMB: parsed.dedicatedVramFreeMB as number,
    sharedGpuMemoryMB: parsed.sharedGpuMemoryMB as number,
  };
}

/** Takes one discrete hardware snapshot by shelling out to powershell.exe. */
export async function getHardwareSnapshot(runner: CommandRunner): Promise<HardwareSnapshot> {
  const script = buildHardwareSnapshotScript();
  const result = await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.exitCode !== 0) {
    throw new Error(`powershell.exe hardware snapshot failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return parseHardwareSnapshotJson(result.stdout);
}

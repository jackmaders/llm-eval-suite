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

$dedicatedUsedMB = 0
$sharedGpuMemoryMB = 0

# GPU Adapter Memory(*) sums usage system-wide across every process on the
# machine — not just LM Studio's own engine — confirmed on real hardware: it
# included the Windows kernel process (pid 4) and 30+ ordinary desktop
# processes (browser tabs, terminals, Explorer, ...) alongside two distinct
# adapter LUIDs for what should be one physical GPU (a stale/duplicate driver
# registration). That made "free VRAM" wildly unreliable — deeply negative
# even at cpu-only GPU offload, since ordinary desktop GPU usage alone (or
# the duplicate-LUID double count) swamped the real figure.
#
# Scope usage to the actual inference engine's own process instead — this
# measures what the guardrail actually needs: whether THIS model's own
# footprint fits, not a whole-desktop VRAM budget shared with everything
# else running. Note this means dedicatedVramFreeMB is "headroom if only
# this model were using the GPU", not a literal system-wide free figure —
# a deliberate tradeoff since the system-wide figure proved unusable.
$enginePids = Get-Process -Name '*llama*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
if ($enginePids) {
  $dedicatedSamples = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples
  $sharedSamples = (Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples
  $dedicatedBytes = 0
  $sharedBytes = 0
  foreach ($enginePid in $enginePids) {
    $dedicatedBytes += ($dedicatedSamples | Where-Object { $_.InstanceName -like "pid_\${enginePid}_*" } | Measure-Object -Property CookedValue -Sum).Sum
    $sharedBytes += ($sharedSamples | Where-Object { $_.InstanceName -like "pid_\${enginePid}_*" } | Measure-Object -Property CookedValue -Sum).Sum
  }
  $dedicatedUsedMB = [math]::Round($dedicatedBytes / 1MB, 2)
  $sharedGpuMemoryMB = [math]::Round($sharedBytes / 1MB, 2)
}

# Win32_VideoController.AdapterRAM is a 32-bit WMI field that caps/wraps at
# 4GB for any GPU with more VRAM than that (a well-documented Windows
# limitation) — silently reporting ~4095MB "total" on a 16GB card and making
# dedicatedVramFreeMB go deeply negative even when the GPU has plenty of
# headroom. Read the true size from the registry instead (the standard
# workaround: HardwareInformation.qwMemorySize under each display adapter's
# driver key), taking the largest value found across adapters since an
# integrated/basic-display-driver entry would report far less than a
# discrete GPU. Falls back to AdapterRAM only if the registry read yields
# nothing (e.g. a non-standard driver).
$vramTotalMB = 0
Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $qwMemorySize = (Get-ItemProperty -Path $_.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
    if ($qwMemorySize -and $qwMemorySize -gt 0) {
      $candidateMB = [math]::Round($qwMemorySize / 1MB, 2)
      if ($candidateMB -gt $vramTotalMB) { $vramTotalMB = $candidateMB }
    }
  }
if ($vramTotalMB -eq 0) {
  $vramTotalMB = [math]::Round((Get-CimInstance Win32_VideoController | Measure-Object -Property AdapterRAM -Sum).Sum / 1MB, 2)
}
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

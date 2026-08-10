// Core data shapes shared across the pipeline. See spec: "Data Models & Type Shapes".

export interface ModelConfig {
  modelKey: string;
  quant: string;
}

export interface HardwareSnapshot {
  ramUsedPercent: number;
  ramUsedGB: number;
  dedicatedVramFreeMB: number;
  sharedGpuMemoryMB: number;
}

export interface ContextLadderStep {
  contextLength: number;
  prefillTokPerSec: number;
  decodeTokPerSec: number;
  timeToFirstTokenMs: number;
  snapshot: HardwareSnapshot;
  speedDropPercent: number;
}

export type KvCacheQuant = "Q8_0";

export interface Phase3TuningProfile {
  modelKey: string;
  quant: string;
  verifiedGpuOffload: string;
  kvCacheQuant: KvCacheQuant;
  maxRecommendedContext: number;
  ladderHistory: ContextLadderStep[];
}

export interface BenchmarkMetrics {
  modelKey: string;
  passRatePercent: number;
  syntaxErrorCount: number;
  avgDecodeSpeed: number;
  thermalDecayPercent: number;
}

export interface CompletedPhases {
  phase1Passed?: boolean;
  phase2Passed?: boolean;
  phase3Profile?: Phase3TuningProfile;
  phase4Metrics?: BenchmarkMetrics;
  discardedAt?: "DISCARDED_PHASE1" | "DISCARDED_PHASE2";
}

export interface PipelineState {
  lastUpdated: string;
  completedPhases: Record<string, CompletedPhases>;
}

/** Result of the Phase 1 high-speed ping filter for a single candidate. */
export interface Phase1Result {
  modelKey: string;
  tokPerSec: number;
  passed: boolean;
}

/** Result of the Phase 2 capability & sanity filter for a single candidate. */
export interface Phase2Result {
  modelKey: string;
  passed: boolean;
  reason?: string;
  parsedJson?: unknown;
}

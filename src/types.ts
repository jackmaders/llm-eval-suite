// Core data shapes shared across the pipeline. See spec: "Data Models & Type Shapes".

export interface ModelConfig {
  modelKey: string;
  quant: string;
  /** Every quantization already downloaded locally for this base model, including `quant`. */
  locallyAvailableQuants?: string[];
  /** The Hugging Face `owner/repo` this GGUF was published under, when derivable from discovery. */
  hfRepoId?: string;
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

/** Result of the opt-in --check-remote-quants lookup (see remoteQuants.ts). */
export interface DownloadRecommendationCheck {
  repoId: string;
  /** Every quantization Hugging Face has published for this model. */
  availableQuants: string[];
  recommendedQuantAlreadyLocal: boolean;
  /** True only when the recommendation is genuinely new — published on HF and not already downloaded. */
  recommendedQuantDownloadable: boolean;
}

export interface CompletedPhases {
  /**
   * The quantization LM Studio currently has selected for this model —
   * recorded up front for every model, since it can't be changed by this
   * suite (see lmstudio-ai/lmstudio-bug-tracker#1462) but is still useful
   * context even for a model discarded before Phase 3 ever runs.
   */
  quant?: string;
  phase1Passed?: boolean;
  /** Measured decode tok/sec from the Phase 1 ping, kept regardless of pass/fail for diagnostics. */
  phase1TokPerSec?: number;
  phase2Passed?: boolean;
  /** Why Phase 2 failed (invalid JSON, schema mismatch, repetition loop, ...), when it did. */
  phase2Reason?: string;
  phase3Profile?: Phase3TuningProfile;
  phase4Metrics?: BenchmarkMetrics;
  /**
   * DISCARDED_* means the phase ran and legitimately failed its gate (too
   * slow, invalid JSON, ...). ERRORED_* means the phase itself threw instead
   * of returning a result — most commonly the LM Studio engine (llama-server)
   * crashing while loading or running this specific model. Either way the
   * model is done being evaluated this run; errorMessage carries detail for
   * the ERRORED_* case.
   */
  discardedAt?: "DISCARDED_PHASE1" | "DISCARDED_PHASE2" | "ERRORED_PHASE1" | "ERRORED_PHASE2" | "ERRORED_PHASE3" | "ERRORED_PHASE4";
  errorMessage?: string;
  /** Set only when --check-remote-quants is on and there was a quant recommendation worth checking. */
  downloadRecommendation?: DownloadRecommendationCheck;
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

import { z } from "zod";
import type { AssessmentState, CheckResult, ExecutionState, TargetDisclosure } from "./index.js";
import type { COMPOSITE_VERSION, CompositePolicy, CompositeResult } from "./composite.js";
import type { PopulationDisclosure } from "./population-disclosure.js";

/** Prototype read model; no new simulation, assessment or gate mutation. */
export const COMPARISON_VERSION = "2026-10-15-comparison.4" as const;
export const ComparisonRequestSchema = z.object({
  baselineBatchId: z.string().min(1).max(160), candidateBatchId: z.string().min(1).max(160),
  /** Selected client intent. Omission preserves an explicit authorized direct comparison. */
  selectedScope: z.object({ projectId: z.string().min(1).max(160), environmentId: z.string().min(1).max(160) }).strict().optional(),
}).strict();
export type ComparisonRequest = z.infer<typeof ComparisonRequestSchema>;
export interface ScopeRef { organizationId: string; projectId: string; environmentId: string }
export interface BatchOperations {
  schemaVersion: "2026-10-15-batch-operations.1";
  observedAt: string;
  runner: { state: "live_lease_observed" | "no_live_lease_observed"; liveLeases: number; expiredUnreconciled: number;
    finishedAttempts: number; lastClaimedAt: string | null; latestLeaseExpiresAt: string | null };
  resources: { queuedRuns: number; claimedRunSlots: number; runSlotLimit: number;
    toolInstances: { creating: number; active: number; paused: number; expired: number; destroyed: number; recoveryRequired: number };
    toolSessions: { preparing: number; ready: number; closing: number; closed: number };
    pendingBindings: number; retainedBindings: number; cleanupPending: number };
  notes: string[];
}
export interface EvaluatorRef { provider: string; model: string; version: string; configurationDigest?: string }
export interface RubricRef { id: string; version: string; digest: string }
export interface RunRef {
  runId: string; attemptId: string | null; repetition: number; execution: ExecutionState;
  assessment: AssessmentState; assessmentId: string | null; reportPath: string;
}
export interface PopulationCounts {
  planned: number; retained: number; started: number; runnerStartObserved: number;
  completed: number; interrupted: number; assessed: number; notAssessable: number; notApplicable: number;
  evaluationAttempts: number; execution: Record<ExecutionState, number>;
  assessment: Record<AssessmentState, number>;
}
export interface LevelStats {
  count: number; distribution: Record<"0" | "1" | "2" | "3" | "4", number>;
  /** Middle ordinal levels; an even sample is not turned into a fictional half-level. */
  median: { lower: number; upper: number } | null;
  range: { minimum: number; maximum: number } | null;
}
export interface MeasurementStats {
  name: "serviceClaimToFinishMs" | "runnerDurationMs" | "runnerLatencyMs" | "targetInputTokens" | "targetOutputTokens" | "targetCostUsd";
  unit: "ms" | "tokens" | "USD";
  provenance: "service_clock_claim_to_finish" | "runner_reported_metrics.durationMs" | "runner_reported_metrics.latencyMs" |
    "runner_reported_metrics.modelUsage.inputTokens" | "runner_reported_metrics.modelUsage.outputTokens" | "runner_reported_metrics.modelUsage.costUsd";
  count: number; missing: number; invalid: number; median: number | null;
  range: { minimum: number; maximum: number } | null;
}
/** Provider-native numeric scores, kept separate from ordinal rubric levels. */
export interface ProviderScoreStats {
  provider: "jev"; scale: [0, 4]; ordinalConversion: "none";
  count: number; mean: number | null; median: number | null;
  range: { minimum: number; maximum: number } | null;
}
export interface DimensionSummary {
  dimensionId: string; evaluator: EvaluatorRef | null; requested: number;
  assessed: number; notAssessable: number; notApplicable: number; missing: number; invalid: number;
  levels: LevelStats;
  providerScores?: ProviderScoreStats;
  samples: { run: RunRef; level: number | null; providerScore?: number | null; state: string; evidenceIds: string[] }[];
  samplesTruncated: boolean;
}
export interface ExactCheckSummary {
  checkId: string; checkDigest: string; required: boolean;
  comparator?: CheckResult["comparator"]; numeric?: CheckResult["numeric"];
  plannedDenominator: number; assessedDenominator: number;
  satisfied: number; violated: number; unknown: number; missing: number;
  violationSamples: RunRef[]; violationSamplesTruncated: boolean;
}
/** Descriptive statistics of an explicitly authored numeric index, not ordinal rubric levels. */
export interface CompositeIndexStats {
  count: number; mean: number | null; median: number | null;
  range: { minimum: number; maximum: number } | null;
}
export interface CompositeCoverage {
  requested: number; computed: number; notAssessable: number; constraintViolation: number;
  /** These component/constraint categories overlap; they are not another denominator. */
  missingDimensionRuns: number; notApplicableDimensionRuns: number; invalidDimensionRuns: number;
  requiredChecksUnknownRuns: number;
  reasons: Record<CompositeResult["reason"], number>;
}
export interface CompositeSummary {
  schemaVersion: typeof COMPOSITE_VERSION;
  policy: CompositePolicy; policyDigest: string; evaluator: EvaluatorRef | null;
  coverage: CompositeCoverage; indices: CompositeIndexStats;
  samples: { run: RunRef; state: CompositeResult["state"]; value: number | null; reason: CompositeResult["reason"] }[];
  samplesTruncated: boolean;
}
export interface PopulationSummary {
  scenarioId: string; scenarioRevision: string; inputDigest: string;
  configurationId: string; configurationDigest: string;
  rubric: RubricRef | null; counts: PopulationCounts;
  dimensions: DimensionSummary[]; exactChecks: ExactCheckSummary[];
  /** Finite task measurements under exact authored definitions; no pooled units or inferred winner. */
  taskMetrics?: import("./task-metrics.js").TaskMetricSummary[];
  /** Present only for an explicitly authored policy; never an inferred universal score. */
  composites?: CompositeSummary[];
  measurements: MeasurementStats[]; sampleRuns: RunRef[]; sampleRunsTruncated: boolean;
}
export interface BatchSummary {
  schemaVersion: typeof COMPARISON_VERSION; batchId: string; scope: ScopeRef;
  snapshotAt: string; targetDigest: string;
  /** Source identity and reset declarations; absent on responses from older services. */
  targetDisclosure?: TargetDisclosure;
  /** Declared case-selection purpose and exact retained materialization metadata; never inferred. */
  populationDisclosure?: PopulationDisclosure;
  /** SHA-256 of canonical retained recipe bindings: alias/operation order ignored, absent dataset normalized to null. */
  serviceBindingsDigest: string; counts: PopulationCounts;
  groups: PopulationSummary[]; notes: string[];
}
export type PairDifference = "scenario_revision" | "input" | "rubric" | "configuration_parameters" | "evaluator" | "evaluator_configuration" | "evaluator_configuration_unavailable" | "target" | "scope" | "service_bindings";
export interface PairSample {
  scenarioId: string; configurationId: string; repetition: number;
  baseline: RunRef | null; candidate: RunRef | null;
  status: "matched" | "missing_baseline" | "missing_candidate" | "scenario_mismatch";
  differences: PairDifference[];
}
/** Complete paired-case traversal, separate from bounded summary examples. */
export interface ComparisonPairsPage {
  schemaVersion: typeof COMPARISON_VERSION; snapshotAt: string;
  baseline: { batchId: string; scope: ScopeRef }; candidate: { batchId: string; scope: ScopeRef };
  items: PairSample[]; total: number; nextCursor: string | null;
}
export const ComparisonPairsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type ComparisonPairsQuery = z.input<typeof ComparisonPairsQuerySchema>;
export interface PairedDimensionSummary {
  scenarioId: string; scenarioRevision: string; inputDigest: string;
  configurationId: string; baselineConfigurationDigest: string; candidateConfigurationDigest: string;
  /** Both sides have these same retained recipe bindings; different bindings are excluded, not pooled. */
  serviceBindingsDigest: string;
  rubric: RubricRef; dimensionId: string; evaluator: EvaluatorRef;
  matchedPairs: number; assessedPairs: number; notApplicablePairs: number; missingOrNotAssessablePairs: number;
  baseline: LevelStats; candidate: LevelStats;
  providerScores?: { provider: "jev"; scale: [0, 4]; ordinalConversion: "none"; assessedPairs: number;
    baseline: ProviderScoreStats; candidate: ProviderScoreStats };
  samples: { baseline: RunRef; candidate: RunRef; baselineLevel: number | null; candidateLevel: number | null;
    baselineProviderScore?: number | null; candidateProviderScore?: number | null }[];
  samplesTruncated: boolean;
}
export type CompositePairExclusion = "missing_baseline" | "missing_candidate" | "policy_not_authored_on_both"
  | "scenario_or_input_mismatch" | "rubric_or_policy_mismatch" | "service_bindings_mismatch"
  | "evaluator_mismatch" | "evaluator_configuration_unavailable" | "evaluator_configuration_mismatch";
export interface CompositePairingCoverage {
  schemaVersion: typeof COMPOSITE_VERSION;
  authoredSlots: number; compatiblePairs: number;
  /** Mutually exclusive reasons, in the listed contract order; no numeric pair is fabricated. */
  excluded: Record<CompositePairExclusion, number>;
}
export interface PairedCompositeSummary {
  schemaVersion: typeof COMPOSITE_VERSION;
  scenarioId: string; scenarioRevision: string; inputDigest: string;
  configurationId: string; baselineConfigurationDigest: string; candidateConfigurationDigest: string;
  serviceBindingsDigest: string; rubric: RubricRef; evaluator: EvaluatorRef;
  policy: CompositePolicy; policyDigest: string;
  matchedPairs: number; computedPairs: number; constraintViolationPairs: number; notAssessablePairs: number;
  baselineCoverage: CompositeCoverage; candidateCoverage: CompositeCoverage;
  /** Both index populations include only the same pairs with two computed values. */
  baseline: CompositeIndexStats; candidate: CompositeIndexStats;
  samples: { baseline: RunRef; candidate: RunRef; baselineValue: number | null; candidateValue: number | null;
    baselineState: CompositeResult["state"]; candidateState: CompositeResult["state"];
    baselineReason: CompositeResult["reason"]; candidateReason: CompositeResult["reason"] }[];
  samplesTruncated: boolean;
}
export interface BatchComparison {
  schemaVersion: typeof COMPARISON_VERSION; snapshotAt: string;
  baseline: BatchSummary; candidate: BatchSummary;
  pairing: {
    rule: "scenario-id/configuration-id/repetition; exact scenario revision and input required";
    /** matched means scenario/input-aligned slots, not identical controlled conditions; inspect differences. */
    slots: number; matched: number; missingBaseline: number; missingCandidate: number;
    scenarioMismatch: number; differences: Record<PairDifference, number>;
    samples: PairSample[]; samplesTruncated: boolean;
  };
  dimensions: PairedDimensionSummary[]; notes: string[];
  /** Optional versioned projection; dimensions and exact checks remain primary. */
  composites?: PairedCompositeSummary[]; compositePairing?: CompositePairingCoverage;
}

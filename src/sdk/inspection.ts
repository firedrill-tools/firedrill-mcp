/** Bounded batch index rows, not execution output or client-calculated verdicts. */
export interface BatchListItem {
  id: string; projectId: string; environmentId: string; name: string; targetKind: string;
  createdAt: string; total: number; cancellationRequested: boolean;
  counts: Record<string, number>; assessments: Record<string, number>; gates: Record<string, number>;
  submission: import("../contracts/index.js").SubmissionMetadata | null;
  overview?: import("../contracts/index.js").BatchOverview;
}
export interface BatchPage { items: Array<(BatchListItem & { metadataOnly?: false; retention?: import("../contracts/index.js").RetentionAvailability }) | import("../contracts/index.js").UnavailableBatchListEntry>; nextCursor: string | null }
export interface AvailableScenarioEntry { metadataOnly?: false; retention?: import("../contracts/index.js").RetentionAvailability; id: string; revision: string; scenario: import("../contracts/index.js").Scenario; createdAt: string; environmentId?: string | null; lastExecution?: import("../contracts/index.js").ScenarioLastExecution | null }
export interface ScenarioPage {
  items: Array<AvailableScenarioEntry | import("../contracts/index.js").UnavailableScenarioEntry>;
  nextCursor: string | null;
}
/** Retained sequence observations. A pending step is not proof of invocation. */
export interface SequenceRecord {
  execution: import("../contracts/index.js").Run["execution"];
  session: null | {
    run_id: string; attempt_id: string; started_at: string; deadline_at: string;
    step_index: number; phase: "running" | "finished";
    execution: "completed" | "error" | "interrupted" | "cancelled";
    output: import("../contracts/index.js").Json; reason: string | null; finished_at: string | null;
    metrics: Record<string, import("../contracts/index.js").Json>; result_bytes: string | number;
  };
  steps: Array<{
    ordinal: number; step_id: string; phase: "pending" | "completed" | "skipped";
    input: import("../contracts/index.js").SequenceStep; result: import("../contracts/index.js").Json;
    poll_attempt: number; started_at: string; finished_at: string | null;
  }>;
}
export type { BatchSummary, BatchComparison, ComparisonPairsPage, BatchOperations, PopulationCounts, LevelStats, DimensionSummary, ExactCheckSummary, MeasurementStats, PopulationSummary, PairedDimensionSummary, PairSample } from "../contracts/index.js";

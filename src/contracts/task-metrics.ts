import type { CheckResult, TaskMetricDefinition } from "./index.js";
import type { RunRef } from "./comparisons.js";

export const TASK_METRIC_VERSION = "2026-10-16-task-metric.1" as const;
export type TaskMetricDirection = "higher_is_better" | "lower_is_better" | "neutral";
interface TaskMetricResultBase {
  schemaVersion: typeof TASK_METRIC_VERSION;
  id: string; definitionDigest: string; label: string; unit: string;
  direction: TaskMetricDirection | null;
  coverage: { sourceAvailable: boolean; selectorFound: boolean };
  /** Runner values are declarations, never service-side effect attestations. */
  provenance: NonNullable<CheckResult["provenance"]> | { kind: "runner_reported" | "scenario_input"; path: string } | null;
}
export type TaskMetricResult = TaskMetricResultBase & (
  | { state: "measured"; value: number; reason: "measured" }
  | { state: "not_assessable"; value: null; reason: "missing_evidence" | "missing_value" | "non_numeric" }
);
/** One exact definition, scenario/configuration cohort and retained assessment population.
 * Units and direction are authored; no conversion, score, winner or CI rule is inferred. */
export interface TaskMetricSummary {
  schemaVersion: typeof TASK_METRIC_VERSION;
  definition: TaskMetricDefinition; definitionDigest: string;
  requested: number; measured: number; notAssessable: number; missing: number; invalid: number;
  median: number | null; range: { minimum: number; maximum: number } | null;
  samples: { run: RunRef; value: number | null; state: "measured" | "not_assessable" | "missing" | "invalid" }[];
  samplesTruncated: boolean;
}

/** Retained measurement projections are separate from scores, gates and invoices. */
export const RUN_MEASUREMENTS_VERSION = "2026-10-16-run-measurements.1" as const;
export const RUN_MEASUREMENT_NAMES = [
  "serviceClaimToFinishMs", "runnerDurationMs", "runnerLatencyMs",
  "targetInputTokens", "targetOutputTokens", "targetCostUsd",
] as const;
export type RunMeasurementName = typeof RUN_MEASUREMENT_NAMES[number];
export type RunMeasurementUnit = "ms" | "tokens" | "USD";
export type RunMeasurementProvenance = "service_clock_claim_to_finish"
  | "runner_reported_metrics.durationMs" | "runner_reported_metrics.latencyMs"
  | "runner_reported_metrics.modelUsage.inputTokens" | "runner_reported_metrics.modelUsage.outputTokens"
  | "runner_reported_metrics.modelUsage.costUsd";
export type RunMeasurement = {
  name: RunMeasurementName;
  unit: RunMeasurementUnit;
  provenance: RunMeasurementProvenance;
} & (
  { state: "observed"; value: number }
  | { state: "not_recorded"; value: null }
  | { state: "invalid"; value: null }
);
export interface RunMeasurements {
  schemaVersion: typeof RUN_MEASUREMENTS_VERSION;
  /** Exactly the six named measurements; missing or invalid observations are not zero. */
  items: RunMeasurement[];
  notes: string[];
}

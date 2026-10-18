export const BATCH_OVERVIEW_VERSION = "2026-10-17-batch-overview.1" as const;
/** Compact list projection. Missing on older or metadata-only records. */
export interface BatchOverview {
  schemaVersion: typeof BATCH_OVERVIEW_VERSION;
  timing: { startedAt: string | null; finishedAt: string | null; durationMs: number | null; basis: "service_claim_to_finish" };
  configurations: { count: number; ids: string[]; complete: boolean };
  scoring: {
    /** Never combine different rubric definitions or evaluator configurations. */
    state: "not_requested" | "single_dimension" | "mixed" | "unavailable";
    dimension?: { id: string; description: string; scale: [0, 4] };
    levels?: [number, number, number, number, number];
    coverage?: { total: number; assessed: number; notAssessable: number; notApplicable: number; pending: number; missing: number };
  };
}

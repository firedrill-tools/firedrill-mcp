export const RESULT_LIFECYCLE_VERSION = "2026-10-17-result-lifecycle.1" as const;
/** Metadata-only recovery read. It never includes retained recipes or outputs. */
export interface BatchLifecycleRead {
  schemaVersion: typeof RESULT_LIFECYCLE_VERSION;
  batchId: string;
  projectId: string;
  environmentId: string;
  retention: import("./retention.js").RetentionAvailability;
  lifecycle: ResultLifecycle;
}
/** Retained facts for the entire batch, not merely the result's bounded run page. */
export interface ResultLifecycle {
  schemaVersion: typeof RESULT_LIFECYCLE_VERSION;
  observedAt: string;
  evidence: {
    /** Completeness is limited to declared uploads and run-owned Tool closure records.
     * It never promises a screenshot, every intended observation, or target correctness. */
    scope: "declared_artifacts_and_run_owned_tools";
    state: "not_requested" | "pending" | "complete" | "incomplete";
    availableArtifacts: number; pendingArtifacts: number; unavailableArtifacts: number;
    toolSessions: number; closedToolSessions: number; incompleteToolSessions: number;
    unavailableRuns: number;
    /** False means some run metadata was removed; aggregate zeros are not proof of cleanup. */
    metadataComplete?: boolean;
  };
  cleanup: {
    toolSessionsOpen: number; toolInstancesPending: number;
    /** Terminal, claimed command runs only. Missing receipt is not confirmed cleanup. */
    commandRuns: number; commandStopsObserved: number; commandStopsUnconfirmed: number; commandStopsMissing: number;
    /** Native/browser/HTTP stop uncertainty explicitly retained by the runner. */
    targetStopsUnconfirmed?: number;
    customerProcessObservation: "runner_reported_not_platform_attested";
  };
  recovery: { state: "required" | "not_indicated"; reasons: string[]; action: "inspect_before_resuming" | "none" };
}

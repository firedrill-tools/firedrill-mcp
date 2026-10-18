import type { AssessmentState, Batch, GateState, Run } from "./index.js";
import type { CiReportReceipt } from "./ci-context.js";

export const BATCH_RECEIPT_VERSION = "2026-10-15-batch-receipt.1" as const;
/** A receipt for existing execution, never an instruction to dispatch it again. */
export interface BatchReceipt {
  schemaVersion: typeof BATCH_RECEIPT_VERSION;
  batch: Pick<Batch, "id" | "projectId" | "environmentId" | "name" | "createdAt" | "cancellationRequested" | "total" | "counts" | "charge">;
  gate: GateState;
  operationId?: string;
  /** Optional local summary-delivery fact, separate from retained execution. */
  ciReport?: CiReportReceipt;
  assessmentCounts: Record<AssessmentState, number> | null;
  lifecycle?: import("./result-lifecycle.js").ResultLifecycle;
  reportUrl: string;
  runSample: Array<Pick<Run, "id" | "repetition" | "execution" | "assessment" | "gate"> & {
    scenarioId: string; configurationId: string;
  }>;
  sample: { returned: number; total: number; complete: boolean; kind: "first_retained_runs_not_a_page" };
  reads: { batch: string; runs: string; summary: string };
  note: string;
}

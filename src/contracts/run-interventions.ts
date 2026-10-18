import { z } from "zod";
import { JsonSchema, ScopeSchema, type Json } from "./index.js";
import type { RetentionAvailability } from "./retention.js";

export const RUN_INTERVENTION_VERSION = "2026-10-15-intervention.1" as const;
export const RUN_CLOCK_INTERVENTION_VERSION = "2026-10-15-intervention.2" as const;
const BindingFields = {
  service: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  instanceId: z.string().regex(/^instance_[a-f0-9]{24}$/),
  epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(2000),
};
/** Original operation-only input stays byte-for-byte compatible. */
export const RunOperationInterventionSchema = z.lazy(() => ScopeSchema.extend({
  schemaVersion: z.literal(RUN_INTERVENTION_VERSION),
  ...BindingFields,
  operationId: z.string().min(1).max(160), arguments: z.record(z.string(), JsonSchema),
}).strict());
export const RunClockInterventionSchema = z.lazy(() => ScopeSchema.extend({
  schemaVersion: z.literal(RUN_CLOCK_INTERVENTION_VERSION), ...BindingFields,
  action: z.literal("clock"), toUs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maxEvents: z.number().int().min(1).max(1000),
}).strict());
export const RunInterventionSchema = z.lazy(() => z.union([RunOperationInterventionSchema, RunClockInterventionSchema]));
export type RunInterventionInput = z.input<typeof RunInterventionSchema>;
export interface RunInterventionReceipt {
  id: string; runId: string; attemptId: string; service: string; instanceId: string;
  epoch: number | null; operationId: string | null; operatorCredentialId: string; reason: string | null;
  action: "invoke" | "clock" | null; toUs: number | null; maxEvents: number | null;
  metadataOnly: boolean; retention?: RetentionAvailability;
  state: "pending" | "complete" | "failed" | "uncertain";
  attribution: "operator_intervention_not_target_action";
  createdAt: string; completedAt: string | null; errorCode: string | null;
  result: Json;
}
export interface RunInterventionPage {
  schemaVersion: typeof RUN_INTERVENTION_VERSION; items: RunInterventionReceipt[]; nextCursor: number | null;
}

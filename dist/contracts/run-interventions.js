import { z } from "zod";
import { JsonSchema, ScopeSchema } from "./index.js";
export const RUN_INTERVENTION_VERSION = "2026-10-15-intervention.1";
export const RUN_CLOCK_INTERVENTION_VERSION = "2026-10-15-intervention.2";
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

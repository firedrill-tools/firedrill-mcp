import { z } from "zod";
/** Prototype read model; no new simulation, assessment or gate mutation. */
export const COMPARISON_VERSION = "2026-10-15-comparison.4";
export const ComparisonRequestSchema = z.object({
    baselineBatchId: z.string().min(1).max(160), candidateBatchId: z.string().min(1).max(160),
    /** Selected client intent. Omission preserves an explicit authorized direct comparison. */
    selectedScope: z.object({ projectId: z.string().min(1).max(160), environmentId: z.string().min(1).max(160) }).strict().optional(),
}).strict();
export const ComparisonPairsQuerySchema = z.object({
    cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

import { z } from "zod";
import { CiContextSchema } from "./ci-context.js";
/** Additive read/declared-provenance contract; no execution or assessment semantics change. */
export const INSPECTION_VERSION = "2026-10-15-inspection.1";
export const KnownSubmissionOriginSchema = z.enum(["cli", "sdk", "mcp", "ci", "api"]);
export const SubmissionMetadataSchema = z.object({ schemaVersion: z.literal(INSPECTION_VERSION), origin: KnownSubmissionOriginSchema,
    ci: CiContextSchema.optional(),
}).strict().superRefine((value, ctx) => {
    if (value.ci && value.origin !== "ci")
        ctx.addIssue({ code: "custom", path: ["ci"], message: "CI context requires explicit ci submission origin; it is caller-declared, not an authority grant." });
});
const boundedId = z.string().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a bounded identifier without control characters.");
const utcDate = z.string().datetime().refine(value => !value.startsWith("0000-") && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value), "Use a valid UTC timestamp with year 0001–9999 and at most 3 fractional digits; finer precision is not supported.").transform(value => new Date(value).toISOString());
export const InspectionFilterFields = {
    q: z.string().trim().min(1).max(100).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a name or identifier prefix without control characters.").optional(),
    createdAfter: utcDate.optional(), createdBefore: utcDate.optional(),
    execution: z.enum(["queued", "running", "completed", "error", "interrupted", "cancelled"]).optional(),
    origin: z.enum(["cli", "sdk", "mcp", "ci", "api", "unknown"]).optional(),
    repository: CiContextSchema.shape.repository.optional(),
    workflowRunId: CiContextSchema.shape.runId.optional(),
    scenarioId: boundedId.optional(), configurationId: boundedId.optional(),
    issue: z.enum(["incomplete", "exact_violation", "assessment_unavailable", "below_level"]).optional(),
    dimensionId: boundedId.optional(), minimumLevel: z.preprocess(value => typeof value === "number" ? value : typeof value === "string" && /^\d$/.test(value) ? Number(value) : NaN, z.number().int().min(0).max(4)).optional(),
};
export const InspectionFiltersSchema = z.object(InspectionFilterFields).strict().superRefine((value, ctx) => {
    if (value.createdAfter && value.createdBefore && Date.parse(value.createdAfter) >= Date.parse(value.createdBefore))
        ctx.addIssue({ code: "custom", path: ["createdBefore"], message: "createdBefore must be later than createdAfter." });
    if (value.issue === "below_level" ? !value.dimensionId || value.minimumLevel === undefined : value.dimensionId !== undefined || value.minimumLevel !== undefined)
        ctx.addIssue({ code: "custom", path: ["dimensionId"], message: "below_level requires dimensionId and minimumLevel; other filters must omit them." });
});
export const ScenarioFiltersSchema = z.object({ q: InspectionFilterFields.q,
    evaluation: z.enum(["quality", "exact", "observation"]).optional(),
    sequence: z.enum(["single", "sequence"]).optional(),
}).strict();
export const INSPECTION_FILTER_KEYS = Object.keys(InspectionFilterFields);
/** Stable ordering is shared by URL serialization and cursor fingerprints. */
export function inspectionFilterQuery(filters) {
    return Object.fromEntries(INSPECTION_FILTER_KEYS.flatMap(key => filters[key] === undefined ? [] : [[key, String(filters[key])]]));
}

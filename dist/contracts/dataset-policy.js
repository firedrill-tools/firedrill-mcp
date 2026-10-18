import { z } from "zod";
export const DATASET_POLICY_VERSION = "2026-10-15-dataset-policy.1";
export const DATASET_METADATA_VERSION = "2026-10-15-dataset-metadata.1";
export const DATASET_VALIDATION_VERSION = "2026-10-15-dataset-validation.1";
const namespace = z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(96);
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Literal JSON pointers only. No expressions, wildcard traversal or inferred relations. */
export const DatasetPointerSchema = z.string().max(512).refine(value => (value === "" || value.startsWith("/")) && !/~(?![01])/u.test(value) &&
    (value === "" || value.slice(1).split("/").length <= 16), "Use a literal JSON pointer with at most 16 segments.");
export const DatasetConstraintSchema = z.discriminatedUnion("kind", [
    z.object({ id, kind: z.literal("unique"), namespace, pointers: z.array(DatasetPointerSchema).min(1).max(8) }).strict(),
    z.object({ id, kind: z.literal("reference"), namespace, pointer: DatasetPointerSchema,
        targetNamespace: namespace, targetPointer: DatasetPointerSchema.optional(), optional: z.boolean().optional() }).strict(),
    z.object({ id, kind: z.literal("count"), namespace, min: z.number().int().min(0).max(100000).optional(),
        max: z.number().int().min(0).max(100000).optional() }).strict().refine(value => (value.min !== undefined || value.max !== undefined) && (value.min === undefined || value.max === undefined || value.min <= value.max), "Declare an ordered minimum and/or maximum count."),
]);
export const DatasetPolicySchema = z.object({ schemaVersion: z.literal(DATASET_POLICY_VERSION),
    constraints: z.array(DatasetConstraintSchema).min(1).max(64) }).strict().refine(value => new Set(value.constraints.map(item => item.id)).size === value.constraints.length, "Constraint IDs must be unique.");
export const DatasetMappingSchema = z.object({ id, namespace, pointer: DatasetPointerSchema, optional: z.boolean().optional(),
    target: z.object({ datasetId: z.string().min(1).max(160), version: digest, namespace,
        pointer: DatasetPointerSchema.optional() }).strict() }).strict();
export const DatasetProvenanceSchema = z.object({ kind: z.enum(["authored", "generated", "imported"]),
    description: z.string().max(512).optional(), sensitive: z.boolean(), authorizedImport: z.literal(true).optional() }).strict()
    .refine(value => value.kind !== "imported" || value.authorizedImport === true, "Imported data requires the caller's explicit authorizedImport assertion; this is not independent consent verification.");
export const DatasetMetadataSchema = z.object({ schemaVersion: z.literal(DATASET_METADATA_VERSION),
    provenance: DatasetProvenanceSchema.optional(), mappings: z.array(DatasetMappingSchema).max(32).optional() }).strict()
    .superRefine((value, ctx) => {
    const mappings = value.mappings ?? [];
    if (new Set(mappings.map(item => item.id)).size !== mappings.length)
        ctx.addIssue({ code: "custom", message: "Mapping IDs must be unique." });
    if (new Set(mappings.map(item => item.target.datasetId)).size > 8)
        ctx.addIssue({ code: "custom", message: "At most eight pinned target datasets may be referenced." });
    const versions = new Map();
    for (const item of mappings) {
        if (versions.has(item.target.datasetId) && versions.get(item.target.datasetId) !== item.target.version)
            ctx.addIssue({ code: "custom", message: "A target dataset must have one exact version." });
        versions.set(item.target.datasetId, item.target.version);
    }
});

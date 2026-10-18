import { z } from "zod";
export const RETAINED_VALUE_VERSION = "2026-10-15-retained-value.1";
export const OPERATOR_DOCUMENT_VERSION = "operator-document-2026-10-15.1";
export const RetainedValueSourceSchema = z.enum(["output", "input", "scenario", "configuration", "target", "assessment", "event", "check_actual", "check_expected", "recipe"]);
const decimal = (schema) => z.preprocess(value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value, schema);
/** Event identity is not a resource ID: service/sequence events use literal colons. */
export const RetainedEventIdSchema = z.string().min(1).max(160).refine(value => !Array.from(value).some(character => { const point = character.codePointAt(0); return point >= 0xd800 && point <= 0xdfff; }), "Use the exact retained event identity with valid Unicode, without normalization.");
export const RetainedValueQuerySchema = z.object({
    source: RetainedValueSourceSchema,
    pointer: z.string().max(4096).default("").refine(value => (!value || value.startsWith("/")) && !/~(?![01])/u.test(value) && value.split("/").length <= 65
        && !Array.from(value).some(character => { const point = character.codePointAt(0); return point >= 0xd800 && point <= 0xdfff; }), "Use an RFC6901 JSON Pointer with at most64segments and valid ~0/~1 escapes."),
    eventId: RetainedEventIdSchema.optional(),
    checkId: RetainedEventIdSchema.optional(),
    offset: decimal(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).default(0),
    limit: decimal(z.number().int().min(256).max(32768)).default(8192),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
    if ((value.source === "event") !== (value.eventId !== undefined))
        ctx.addIssue({ code: "custom", path: ["eventId"], message: "eventId is required only for event values." });
    if (["check_actual", "check_expected"].includes(value.source) !== (value.checkId !== undefined))
        ctx.addIssue({ code: "custom", path: ["checkId"], message: "checkId is required only for exact-check operand values." });
    if (value.offset > 0 && !value.sha256)
        ctx.addIssue({ code: "custom", path: ["sha256"], message: "Continue with the digest returned by the first value chunk." });
});

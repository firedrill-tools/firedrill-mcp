import { z } from "zod";
/** Activity filtering selects retained literal fields, never inferred actor roles or payload contents. */
export const ACTIVITY_VERSION = "2026-10-16-activity.1";
const literal = (maximum) => z.string().min(1).max(maximum).refine(value => !/[\x00-\x1f\x7f]/.test(value) && !Array.from(value).some(character => {
    const point = character.codePointAt(0);
    return point >= 0xd800 && point <= 0xdfff;
}), "Use a literal value without control characters or unpaired Unicode surrogates.");
export const ActivityFiltersSchema = z.object({
    eventKind: literal(120).optional(),
    eventProducer: literal(200).optional(),
}).strict();
export const ACTIVITY_FILTER_KEYS = ["eventKind", "eventProducer"];
/** Stable URL fields; neither values nor case are normalized. */
export function activityFilterQuery(filters) {
    return Object.fromEntries(ACTIVITY_FILTER_KEYS.flatMap(key => filters[key] === undefined ? [] : [[key, filters[key]]]));
}
export const ActivityPageMetadataSchema = z.object({
    schemaVersion: z.literal(ACTIVITY_VERSION), filters: ActivityFiltersSchema,
    filtered: z.boolean(), afterSequence: z.number().int().min(0).max(2147483647),
}).strict().superRefine((value, ctx) => {
    if (value.filtered !== (Object.keys(activityFilterQuery(value.filters)).length > 0))
        ctx.addIssue({ code: "custom", path: ["filtered"], message: "The retained selection flag must agree with its literal filters." });
});
/** A service that ignored a filter must not look like a confirmed filtered read. */
export function activitySelectionMatches(metadata, filters) {
    const selected = ActivityFiltersSchema.safeParse(filters), page = ActivityPageMetadataSchema.safeParse(metadata);
    return selected.success && page.success && ACTIVITY_FILTER_KEYS.every(key => selected.data[key] === page.data.filters[key]);
}

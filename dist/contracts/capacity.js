import { z } from "zod";
export const CAPACITY_REQUEST_VERSION = "2026-10-18-capacity.1";
export const CapacityResourceSchema = z.enum(["runs", "services", "storage", "other"]);
export const CapacityRequestSchema = z.object({
    projectId: z.string().regex(/^prj_[a-f0-9]{24}$/),
    environmentId: z.string().regex(/^env_[a-f0-9]{24}$/),
    resource: CapacityResourceSchema.default("other"),
    message: z.string().trim().min(1).max(4000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), "Do not include control characters.").optional(),
    requestedCapacity: z.number().int().min(1).max(1_000_000_000).optional(),
    replyTo: z.string().max(254).email().refine(value => !/[\x00-\x20\x7f]/.test(value), "Use an email address without whitespace or control characters.").optional(),
}).strict();
export const CapacityRequestCreateSchema = CapacityRequestSchema;
export const CapacityRequestPageSchema = z.object({
    cursor: z.string().regex(/^capreq_[a-f0-9]{24}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const CapacityRequestActionSchema = z.object({
    path: z.literal("/v1/capacity-requests"),
    cli: z.literal("firedrill capacity request"),
    portalPath: z.literal("/app/settings?tab=capacity"),
}).strict();
/** Accept only the known same-service action, never an arbitrary URL from an error. */
export function readCapacityRequestAction(details) {
    if (!details || typeof details !== "object" || Array.isArray(details))
        return undefined;
    const parsed = CapacityRequestActionSchema.safeParse(details.capacityRequest);
    return parsed.success ? parsed.data : undefined;
}

import { z } from "zod";
export const SERVICE_INSTANCE_LIST_VERSION = "2026-10-15-service-list.1";
/** Omit order for the legacy ascending numeric-cursor interface. */
export const ServiceInstanceListSchema = z.object({
    order: z.literal("newest"),
    lifecycle: z.enum(["active", "history", "all"]).default("all"),
    q: z.string().trim().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
    status: z.enum(["creating", "active", "paused", "recovery_required", "expired", "destroyed"]).optional(),
    cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.number().int().min(1).max(100).default(25),
}).strict();

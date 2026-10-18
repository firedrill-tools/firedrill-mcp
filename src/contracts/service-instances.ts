import { z } from "zod";

export const SERVICE_INSTANCE_LIST_VERSION = "2026-10-15-service-list.1" as const;
/** Omit order for the legacy ascending numeric-cursor interface. */
export const ServiceInstanceListSchema = z.object({
  order: z.literal("newest"),
  lifecycle: z.enum(["active", "history", "all"]).default("all"),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();
export type ServiceInstanceListQuery = z.input<typeof ServiceInstanceListSchema>;
export interface ServiceInstanceListPage<T = Record<string, unknown>> {
  schemaVersion: typeof SERVICE_INSTANCE_LIST_VERSION;
  order: "newest"; lifecycle: "active" | "history" | "all";
  items: T[]; nextCursor: string | null;
}

import { z } from "zod";
export const RETENTION_VERSION = "2026-10-15-retention.1";
export const RETENTION_DURATIONS = Object.freeze({ runPayloadDays: 30, reusableStateDaysAfterCompute: 7, metadataDays: 365, operationalLogDays: 14 });
const opaque = z.string().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Scope = z.object({ projectId: z.string().regex(/^prj_[a-f0-9]{24}$/), environmentId: z.string().regex(/^env_[a-f0-9]{24}$/) });
export const RetentionResourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("batch"), id: opaque }).strict(),
    z.object({ kind: z.literal("run"), id: opaque }).strict(),
    z.object({ kind: z.literal("scenario"), id: opaque, revision: digest }).strict(),
    z.object({ kind: z.literal("build"), id: opaque }).strict(),
    z.object({ kind: z.literal("dataset"), id: opaque }).strict(),
    z.object({ kind: z.literal("instance"), id: opaque }).strict(),
    z.object({ kind: z.literal("artifact"), id: opaque, runId: opaque }).strict(),
    z.object({ kind: z.literal("recommendation"), id: z.string().regex(/^recommendation_[a-f0-9]{24}$/) }).strict(),
]);
export const RemovalPreviewSchema = Scope.extend({ schemaVersion: z.literal(RETENTION_VERSION), targets: z.array(RetentionResourceSchema).min(1).max(1000) }).strict();
export const RemovalCommitSchema = RemovalPreviewSchema.extend({ graphDigest: digest, confirmationDigest: digest,
    cascade: z.array(RetentionResourceSchema).max(10000).default([]) }).strict();

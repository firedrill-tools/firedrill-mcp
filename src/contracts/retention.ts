import { z } from "zod";
import type { ExecutionState, AssessmentState, GateState, Run } from "./index.js";

export const RETENTION_VERSION = "2026-10-15-retention.1" as const;
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
export type RetentionResource = z.infer<typeof RetentionResourceSchema>;
export const RemovalPreviewSchema = Scope.extend({ schemaVersion: z.literal(RETENTION_VERSION), targets: z.array(RetentionResourceSchema).min(1).max(1000) }).strict();
export const RemovalCommitSchema = RemovalPreviewSchema.extend({ graphDigest: digest, confirmationDigest: digest,
  cascade: z.array(RetentionResourceSchema).max(10000).default([]) }).strict();
export type RemovalPreviewInput = z.infer<typeof RemovalPreviewSchema>;
export type RemovalCommitInput = z.infer<typeof RemovalCommitSchema>;
export type ContentAvailability = "available" | "historical_preserved" | "expired" | "deletion_pending" | "deleted";
export interface RetentionAvailability {
  schemaVersion: typeof RETENTION_VERSION;
  policyVersion: typeof RETENTION_VERSION | "historical_preserved";
  state: ContentAvailability;
  payloadExpiresAt: string | null;
  metadataExpiresAt: string | null;
  removalId: string | null;
}
export interface RemovalPreview {
  schemaVersion: typeof RETENTION_VERSION;
  projectId: string; environmentId: string;
  targets: RetentionResource[];
  resources: Array<{ resourceId: string; resource: RetentionResource; projectId: string; environmentId: string | null; availability: RetentionAvailability }>;
  requiredCascade: RetentionResource[];
  survivingDefinitions: RetentionResource[];
  graphDigest: string; confirmationDigest: string;
  effect: "purge_selected_live_payload_copies_preserve_permitted_tombstones";
  backupDisposition: "separate_retention_no_instant_erasure";
}
export type RemovalPhase = "fenced" | "ledger_pending" | "purging" | "blocked" | "complete";
export interface RemovalReceipt {
  schemaVersion: typeof RETENTION_VERSION;
  id: string; projectId: string; environmentId: string; phase: RemovalPhase;
  reason: "explicit" | "expiry"; graphDigest: string; createdAt: string; completedAt: string | null;
  counts: { resources: number; files: number; bytes: number };
  errorCode: string | null;
  livePayloadDeleted: boolean;
  backupDisposition: "separate_retention_no_instant_erasure";
}
export interface RetentionMetadataRecord {
  id: string; kind: RetentionResource["kind"]; projectId: string; environmentId: string | null;
  availability: RetentionAvailability;
  createdAt: string;
  /** Fixed service facts only. Authored names, arbitrary metrics and payloads are not metadata. */
  facts: { execution?: ExecutionState; assessmentState?: AssessmentState; gate?: GateState; total?: number; finishedAt?: string | null };
}
export interface RetentionPolicyDisclosure {
  schemaVersion:typeof RETENTION_VERSION; activatedAt:string|null; newResourcePolicyActive:boolean;
  runPayloadDays:30; reusableStateDaysAfterCompute:7; metadataDays:365; operationalLogDays:14;
  checkedAt:string; estimatedRunPayloadExpiresAt:string|null; estimateBinding:false;
  existingRecords:"historical_preserved"; savedDefinitions:"until_explicit_authorized_deletion";
  backupDisposition:"separate_retention_no_instant_erasure";
  operationalLogRetention:"deployment_verification_separate";authLifetimes:"unchanged";
}
export interface UnavailableRun {
  metadataOnly:true;retention:RetentionAvailability;
  id:string;batchId:string;projectId:string;environmentId:string;
  execution:ExecutionState;assessment:AssessmentState;gate:GateState;
  attemptId:string|null;startedAt:string|null;finishedAt:string|null;repetition:number;
}
export type RetainedRun= (Run & {metadataOnly?:false;retention?:RetentionAvailability}) | UnavailableRun;
export interface UnavailableBatchListEntry {
  metadataOnly:true;retention:RetentionAvailability;
  id:string;projectId:string;environmentId:string;createdAt:string;total:number;cancellationRequested:boolean;
  counts:Partial<Record<ExecutionState,number>>;assessments:Partial<Record<AssessmentState,number>>;gates:Partial<Record<GateState,number>>;
}
export interface UnavailableScenarioEntry {
  metadataOnly:true;retention:RetentionAvailability;id:string;projectId:string;createdAt:string;
}
export interface UnavailableArtifact {
  metadataOnly:true;retention:RetentionAvailability;id:string;runId:string;
}
export interface UnavailableServiceDefinition {
  metadataOnly:true;retention:RetentionAvailability;id:string;projectId:string;createdAt:string;
}
export interface UnavailableServiceInstance {
  metadataOnly:true;retention:RetentionAvailability;id:string;projectId:string;environmentId:string;createdAt:string;
}

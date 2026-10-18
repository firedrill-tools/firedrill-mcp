import { z } from "zod";

export const CREDENTIAL_VERSION = "2026-10-14-credential.1" as const;
export const MachineCapabilitySchema = z.enum(["read", "runs:write", "runs:execute", "assessments:create", "services:publish", "services:create", "services:invoke", "services:control"]);
export const CreateCredentialSchema = z.object({
  schemaVersion: z.literal(CREDENTIAL_VERSION),
  label: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/),
  projectId: z.string().regex(/^prj_[a-f0-9]{24}$/), environmentId: z.string().regex(/^env_[a-f0-9]{24}$/),
  capabilities: z.array(MachineCapabilitySchema).min(1).max(8),
  expiresInSeconds: z.number().int().min(60).max(7776000).default(2592000),
}).strict().refine(value => new Set(value.capabilities).size === value.capabilities.length, "Choose each capability once.");
export type MachineCapability = z.infer<typeof MachineCapabilitySchema>;
export type CreateCredentialInput = z.input<typeof CreateCredentialSchema>;
export interface CredentialMetadata {
  id: string; label: string; organizationId: string; projectId: string; environmentId: string;
  capabilities: MachineCapability[]; issuerId: string; createdAt: string; expiresAt: string; revokedAt: string | null;
}
export interface CredentialIssue { credential: CredentialMetadata; token: string }
export interface CredentialPage { items: CredentialMetadata[]; nextCursor: string | null }

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArtifactSchema, type Artifact, type ArtifactReference } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
import type { Work } from "./journal.js";

export interface AttachmentInput { path: string; artifact: Artifact }
export type AvailableArtifact = ArtifactReference & { state: "available" };
export type AttachmentSink = (input: AttachmentInput) => Promise<AvailableArtifact>;
export interface AttachmentFailureDiagnostic { causeCode: string; phase: "declaration" | "upload"; status?: number; requestId?: string }
export interface AttachmentIntent extends AttachmentInput { key: string; state: "pending" | "available"; retained?: AvailableArtifact; lastFailure?: AttachmentFailureDiagnostic }
export interface AttachmentTransport {
  declare(path: string, body: unknown, key: string): Promise<ArtifactReference>;
  upload(path: string, content: Buffer, mediaType: string, attemptId: string, leaseToken: string): Promise<ArtifactReference>;
}
function bytes(input: AttachmentInput): Buffer {
  const file = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== input.artifact.bytes || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new FiredrillError("ARTIFACT_FILE_UNSAFE", "Attachment is not the expected private regular file.", "Preserve the original capture; use a current-user-owned, 0600 file without symlinks.");
    const content = readFileSync(file);
    if (content.length !== input.artifact.bytes || createHash("sha256").update(content).digest("hex") !== input.artifact.sha256)
      throw new FiredrillError("ARTIFACT_CONTENT_CHANGED", "Attachment no longer matches its saved size and digest.", "Restore the exact original bytes; never replace evidence under an existing artifact ID.");
    return content;
  } finally { closeSync(file); }
}
function checked(ref: ArtifactReference, input: AttachmentIntent, work: Work): ArtifactReference {
  if (ref.id !== input.artifact.id || ref.runId !== work.claim!.run.id || ref.attemptId !== work.claim!.attemptId || ref.bytes !== input.artifact.bytes || ref.sha256 !== input.artifact.sha256)
    throw new FiredrillError("ARTIFACT_RESPONSE_MISMATCH", "Attachment acknowledgement does not match this exact run, attempt and content.", "Keep the journal and inspect the retained artifact; do not re-run the target.");
  return ref;
}
export function attachmentCoordinator(work: Work, save: () => void, transport: AttachmentTransport): { attach: AttachmentSink; reconcile: () => Promise<void> } {
  const pending = new Map<string, Promise<AvailableArtifact>>();
  const upload = async (intent: AttachmentIntent): Promise<AvailableArtifact> => {
    if (intent.state === "available" && intent.retained) return intent.retained;
    if (!work.claim?.leaseToken) throw new FiredrillError("ARTIFACT_UPLOAD_PENDING", "This attachment still needs its original active execution lease.", "Inspect the retained run and preserved capture; no target is re-invoked to recover an attachment.");
    const scope = `/v1/runs/${encodeURIComponent(work.claim.run.id)}/artifacts`;
    let phase: AttachmentFailureDiagnostic["phase"] = "declaration";
    try {
      // Read and validate before any network write; this Buffer cannot change under the upload.
      const content = bytes(intent);
      let ref = checked(await transport.declare(scope, { attemptId: work.claim.attemptId, leaseToken: work.claim.leaseToken, artifact: intent.artifact }, intent.key), intent, work);
      if (ref.state !== "available") {
        phase = "upload";
        ref = checked(await transport.upload(`${scope}/${encodeURIComponent(intent.artifact.id)}/content`, content, intent.artifact.mediaType, work.claim.attemptId, work.claim.leaseToken), intent, work);
      }
      if (ref.state !== "available") throw new Error("Upload not available");
      intent.state = "available"; intent.retained = { ...ref, state: "available" }; save();
      return intent.retained;
    } catch (error) {
      if (error instanceof FiredrillError && ["ARTIFACT_FILE_UNSAFE", "ARTIFACT_CONTENT_CHANGED", "ARTIFACT_RESPONSE_MISMATCH"].includes(error.code)) { save(); throw error; }
      const causeCode = error instanceof FiredrillError && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.code) ? error.code : "TRANSPORT_UNCERTAIN";
      const status = error instanceof FiredrillError ? error.details.status : undefined;
      const requestId = error instanceof FiredrillError && typeof error.details.requestId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(error.details.requestId) ? error.details.requestId : undefined;
      intent.lastFailure = { causeCode, phase, ...(status === undefined ? {} : { status }), ...(requestId ? { requestId } : {}) }; save();
      throw new FiredrillError("ARTIFACT_UPLOAD_PENDING", "Artifact upload is not confirmed; its exact intent and local file were preserved.", "Resume this operation while the original lease is active. If expired, inspect the interrupted run and preserve its local capture; never re-run the target to recover bytes.", { uncertain: true, ...intent.lastFailure });
    }
  };
  const once = (intent: AttachmentIntent) => {
    const current = pending.get(intent.artifact.id); if (current) return current;
    const operation = upload(intent).finally(() => pending.delete(intent.artifact.id)); pending.set(intent.artifact.id, operation); return operation;
  };
  return {
    attach: async input => {
      const parsed = ArtifactSchema.safeParse(input.artifact);
      if (!parsed.success) throw new FiredrillError("ARTIFACT_INVALID", "Attachment metadata does not satisfy the versioned artifact contract.", "Use a supported media type, bounded size, SHA-256 and stable artifact ID.");
      if (!work.claim || !(work.phase === "running" || work.phase === "sequence" && work.sequenceStep?.phase === "running")) throw new FiredrillError("ARTIFACT_LEASE_INACTIVE", "Attachments require this invocation's active runner lifecycle.", "Await context.attach inside the target callback, before it returns.");
      work.attachments ??= [];
      let intent = work.attachments.find(item => item.artifact.id === parsed.data.id);
      if (intent && JSON.stringify(intent.artifact) !== JSON.stringify(parsed.data)) throw new FiredrillError("ARTIFACT_ID_CONFLICT", "An artifact ID already describes different captured evidence.", "Use its original metadata and file; new captures require a new ID.");
      if (!intent) {
        intent = { path: resolve(input.path), artifact: parsed.data, key: randomUUID(), state: "pending" };
        bytes(intent); work.attachments.push(intent); save(); // Intent is durable before either upload request.
      }
      return once(intent);
    },
    reconcile: async () => { for (const intent of work.attachments ?? []) await once(intent); },
  };
}

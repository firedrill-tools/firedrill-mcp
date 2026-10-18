import { validationDiagnostics, validationMessage, type SchemaIssue, type BatchLifecycleRead } from "../contracts/index.js";
import type { ServiceBuildFailure } from "./service-build-diagnostics.js";

export const CLIENT_DIAGNOSTICS_VERSION = "2026-10-17-client-diagnostics.1" as const;
export type DiagnosticCategory = "validation" | "authentication" | "permission" | "capacity" | "infrastructure" | "interrupted" | "uncertain" | "unsupported" | "evidence";
export type RetrySafety = "never" | "same_request" | "reconcile";
export type WorkStarted = boolean | "unknown";
/** Conservative adapter error signal, not a target result or metric. Follow
 * bounded causes/aggregate errors so a native wrapper cannot erase an inner timeout. */
export function targetStopUnconfirmed(error: unknown): boolean {
  const seen = new Set<object>(), pending: unknown[] = [error];
  for (let inspected = 0; pending.length && inspected < 32; inspected++) {
    error = pending.shift();
    if (error === null || typeof error !== "object" || seen.has(error)) continue;
    seen.add(error);
    try {
      if (Object.getOwnPropertyDescriptor(error, "stopUnconfirmed")?.value === true) return true;
      pending.push(Object.getOwnPropertyDescriptor(error, "cause")?.value);
      if (error instanceof AggregateError) {
        const errors = Object.getOwnPropertyDescriptor(error, "errors")?.value;
        if (Array.isArray(errors)) pending.push(...errors.slice(0, 32 - inspected));
      }
    } catch { /* Never invoke arbitrary error getters while inspecting a failure. */ }
  }
  return false;
}
export function diagnosticCategory(code: string, status?: number, uncertain = false): DiagnosticCategory {
  // Failure semantics outrank subsystem labels: a login transport uncertainty
  // is not a credential rejection, and AUTHORING does not contain an AUTH token.
  if (uncertain || /UNCERTAIN|UNCONFIRMED|RECOVERY_REQUIRED|REFRESH_PENDING/i.test(code)) return "uncertain";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 429) return "capacity";
  if (status !== undefined && status >= 500) return "infrastructure";
  if (/CANCEL|INTERRUPT|LEASE_EXPIRED/i.test(code)) return "interrupted";
  if (/CAPACITY|ADMISSION|BUDGET|QUOTA|RESOURCE_LIMIT|BACKPRESSURE/i.test(code)) return "capacity";
  if (/PERMISSION|DENIED|SCOPE_RESTRICTED/i.test(code)) return "permission";
  if (/UNSUPPORTED|INCOMPATIBLE|RUNNER_REQUIRED|TARGET_REQUIRED/i.test(code)) return "unsupported";
  if (/ARTIFACT|EVIDENCE|CONTENT_(?:UNAVAILABLE|EXPIRED|DELETED|DELETION_PENDING)/i.test(code)) return "evidence";
  if (/TRANSPORT|CLIENT_ERROR|INTERNAL|UNAVAILABLE/i.test(code)) return "infrastructure";
  if (/(?:^|_)(?:AUTH|AUTHENTICATION|AUTHORIZATION|OAUTH|LOGIN|IDENTITY|CREDENTIAL_EXPIRED)(?:_|$)/i.test(code)) return "authentication";
  return "validation";
}
export interface ClientErrorDetails {
  requestId?: string; status?: number; operationId?: string; batchId?: string; runId?: string; stepId?: string; receiptPath?: string;
  validation?: unknown; uncertain?: boolean; workStarted?: WorkStarted; retry?: RetrySafety; category?: DiagnosticCategory;
  causeCode?: string; phase?: "declaration" | "upload"; buildId?: string; failure?: ServiceBuildFailure;
  /** Separately authorized metadata read; never a fabricated payload/result. */
  retainedLifecycle?: BatchLifecycleRead;
}
export class FiredrillError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly repair: string,
    readonly details: ClientErrorDetails = {},
  ) {
    super(message); this.name = "FiredrillError"; this.details = { ...details };
    if (this.details.status !== undefined && (!Number.isSafeInteger(this.details.status) || this.details.status < 100 || this.details.status > 599)) delete this.details.status;
    if (this.details.causeCode !== undefined && (typeof this.details.causeCode !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(this.details.causeCode))) delete this.details.causeCode;
    if (this.details.phase !== undefined && !["declaration", "upload"].includes(this.details.phase)) delete this.details.phase;
  }
  toJSON() {
    const uncertain = this.details.uncertain ?? /UNCERTAIN|UNCONFIRMED|RECOVERY_REQUIRED|REFRESH_PENDING/i.test(this.code);
    const category = this.details.category ?? diagnosticCategory(this.code, this.details.status, uncertain);
    const workStarted = this.details.workStarted ?? "unknown";
    const retry = this.details.retry ?? (uncertain || this.details.operationId || this.details.batchId || this.details.runId ? "reconcile" : "never");
    return { error: { schemaVersion: CLIENT_DIAGNOSTICS_VERSION, code: this.code, message: this.message, repair: this.repair,
      ...this.details, category, workStarted, uncertain, retry } };
  }
}

/** Presentation only: the caller's canonical schema remains the validator.
 * Do not serialize raw schema issues: their messages/keys can contain input. */
export function definitionError(code: string, summary: string, repair: string,
  issues: ReadonlyArray<SchemaIssue>): FiredrillError {
  const validation = validationDiagnostics(issues);
  return new FiredrillError(code, validationMessage(summary, validation), repair, { validation, workStarted: false, uncertain: false, retry: "never" });
}

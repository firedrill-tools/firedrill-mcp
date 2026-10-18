import { RetainedEventIdSchema, type RetainedValueOptions } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
import { activityReportQuery, type InspectReportOptions } from "./activity.js";

export { RETAINED_VALUE_VERSION, OPERATOR_DOCUMENT_VERSION } from "../contracts/index.js";
export type { RetainedValueOptions, RetainedValueChunk, RetainedValueReference, RetainedValueSource, RetainedValueType, OperatorDocument } from "../contracts/index.js";
export type RunRetainedValueOptions = Omit<RetainedValueOptions, "source"> & {
  source: Exclude<RetainedValueOptions["source"], "recipe">;
};
export type BatchRetainedValueOptions = Omit<RetainedValueOptions, "source" | "eventId" | "checkId"> & {
  source?: "recipe";
};
export type { InspectReportOptions } from "./activity.js";

function invalid(message: string): never {
  throw new FiredrillError("RETAINED_VALUE_INVALID", message,
    "Select an exact retained resource and JSON Pointer. Continue with the returned nextOffset and sha256; never rerun the target to retrieve saved content. No request was sent.");
}

function resourceId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    invalid("A retained resource ID of 1–160 letters, digits, underscores or hyphens is required.");
  return encodeURIComponent(value);
}

/** Read one bounded JSON serialization. Does not fetch further chunks implicitly. */
export function retainedValuePath(kind: "run" | "batch", selectedId: string,
  options: RunRetainedValueOptions | BatchRetainedValueOptions): string {
  const selected = resourceId(selectedId);
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["source", "pointer", "eventId", "checkId", "offset", "limit", "sha256"].includes(key)))
    invalid("Supply only source, pointer, eventId, checkId, offset, limit and sha256.");
  const source = options.source ?? (kind === "batch" ? "recipe" : undefined);
  if (typeof source !== "string" || !(kind === "batch" ? ["recipe"]
    : ["output", "input", "scenario", "configuration", "target", "assessment", "event", "check_actual", "check_expected"]).includes(source))
    invalid(kind === "batch" ? "Batch reads support only source recipe." : "Choose a retained run source, not recipe.");
  const eventId = (options as RetainedValueOptions).eventId;
  if (source === "event") {
    if (!RetainedEventIdSchema.safeParse(eventId).success) invalid("Use the exact retained event identity, 1–160 valid Unicode characters including its literal service/sequence separators.");
  } else if (eventId !== undefined) invalid("eventId is only valid with source event.");
  const checkId = (options as RetainedValueOptions).checkId;
  if (source === "check_actual" || source === "check_expected") {
    if (!RetainedEventIdSchema.safeParse(checkId).success) invalid("Use the exact authored checkId for this retained operand.");
  } else if (checkId !== undefined) invalid("checkId is only valid with source check_actual/check_expected.");
  const { pointer = "", offset = 0, limit = 8192, sha256 } = options;
  if (typeof pointer !== "string" || pointer.length > 4096 || (pointer !== "" && !pointer.startsWith("/"))
    || /~(?:[^01]|$)/.test(pointer) || pointer.split("/").length - 1 > 64
    || Buffer.from(pointer, "utf8").toString("utf8") !== pointer)
    invalid("pointer must be an RFC 6901 JSON Pointer of at most 4096 characters and 64 segments, or empty for the selected source.");
  if (!Number.isSafeInteger(offset) || offset < 0) invalid("offset must be a nonnegative safe integer.");
  if (!Number.isInteger(limit) || limit < 256 || limit > 32768) invalid("limit must be an integer between 256 and 32768 bytes.");
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)))
    invalid("sha256 must be the returned 64-character lowercase hexadecimal digest.");
  if (offset > 0 && sha256 === undefined) invalid("Continuation requires the digest from the first chunk.");
  const query = new URLSearchParams({ source, pointer, offset: String(offset), limit: String(limit) });
  if (eventId !== undefined) query.set("eventId", eventId);
  if (checkId !== undefined) query.set("checkId", checkId);
  if (sha256 !== undefined) query.set("sha256", sha256);
  return `/v1/${kind === "batch" ? "batches" : "runs"}/${selected}/value?${query}`;
}

export function operatorReportPath(selectedRunId: string, options: InspectReportOptions = {}): string {
  const selected = resourceId(selectedRunId);
  const query = activityReportQuery(options, true);
  return `/v1/runs/${selected}/report?${query}`;
}

export function operatorBatchPath(selectedBatchId: string): string {
  return `/v1/batches/${resourceId(selectedBatchId)}?view=operator`;
}

import { ActivityFiltersSchema, activityFilterQuery, activitySelectionMatches, type ActivityFilters } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";

export interface ReportOptions extends ActivityFilters { cursor?: string; limit?: number }
export interface InspectReportOptions extends ReportOptions { checkCursor?: string }

/** Fail closed for requested filtering, while preserving old unfiltered reports. */
export function confirmActivitySelection<T>(response: T, filters: ActivityFilters, operator = false): T {
  if (filters.eventKind === undefined && filters.eventProducer === undefined) return response;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const body = operator ? record(record(response)?.value) : record(response);
  if (!activitySelectionMatches(body?.activity, filters)) throw new FiredrillError("ACTIVITY_SELECTION_UNCONFIRMED",
    "The service did not confirm the requested activity filters.",
    "Use matching client/service versions, or deliberately clear the activity filters for an unfiltered read. No automatic retry or target execution occurred.");
  return response;
}

function invalid(message: string): never {
  throw new FiredrillError("ACTIVITY_QUERY_INVALID", message,
    "Omit cursor for the first page. Reuse the returned nextCursor with the same eventKind and eventProducer; clear it when changing filters. No request was sent.");
}

/** Select literal retained fields only. Cursor bindings are validated by the service. */
export function activityReportQuery(options: ReportOptions | InspectReportOptions, operator = false): URLSearchParams {
  const keys = ["cursor", "limit", "eventKind", "eventProducer", ...(operator ? ["checkCursor"] : [])];
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key)))
    invalid(`Supply only ${keys.join(", ")} for this report view.`);
  const parsed = ActivityFiltersSchema.safeParse({ eventKind: options.eventKind, eventProducer: options.eventProducer });
  if (!parsed.success) throw definitionError("ACTIVITY_FILTER_INVALID", "Activity filters are invalid.",
    "Use an exact event kind or literal producer prefix without control characters; preserve case and spaces. No request was sent.", parsed.error.issues);
  const filters = activityFilterQuery(parsed.data), filtered = Object.keys(filters).length > 0;
  const { cursor, limit = operator ? 10 : 100 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > (operator ? 20 : 100))
    invalid(`Report limit must be an integer between 1 and ${operator ? 20 : 100}.`);
  const query = new URLSearchParams({ ...(operator ? { view: "operator" } : {}), limit: String(limit), ...filters });
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length > 1024) invalid("Activity cursor must be a returned string of at most 1024 characters.");
    // Empty/zero is the existing first-page sentinel. A positive numeric cursor
    // cannot carry a filtered scope; opaque cursors must not be decoded here.
    if (cursor !== "" && cursor !== "0") {
      if (filtered ? !/^[A-Za-z0-9_-]+$/.test(cursor) || /^[0-9]+$/.test(cursor)
        : !/^[1-9][0-9]*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) > 100000000)
        invalid("Use an opaque cursor for filtered activity; unfiltered activity uses a nonnegative decimal cursor up to 100000000.");
    }
    query.set("cursor", cursor);
  }
  if (operator) {
    const checkCursor = (options as InspectReportOptions).checkCursor;
    if (checkCursor !== undefined) {
      if (typeof checkCursor !== "string" || !/^(0|[1-9][0-9]*)$/.test(checkCursor)
        || !Number.isSafeInteger(Number(checkCursor)) || Number(checkCursor) > 1000000)
        invalid("checkCursor must be the returned nonnegative decimal cursor up to 1000000.");
      query.set("checkCursor", checkCursor);
    }
  }
  return query;
}

/** Bounded presentation of canonical schema issues. Never serialize raw issues. */
export interface ValidationIssue {
  path: Array<string | number>; code: string; message: string; pathTruncated?: true;
}
export interface ValidationDiagnostics {
  issues: ValidationIssue[]; totalIssues: number; omittedIssues: number;
}
export interface SchemaIssue {
  code: string; path: ReadonlyArray<PropertyKey>; expected?: unknown; message?: string;
}

const dataBranches = new Set(["input", "expected", "arguments", "parameters", "serviceDatasets", "minimumLevels", "metrics", "metadata", "properties", "definitions", "patternProperties", "dependentSchemas"]);
// Exact static prose from the canonical schemas. Arbitrary custom messages may
// contain submitted values, including messages supplied by a caller error map.
const staticConstraints = new Set([
  "Use plain relative paths without hidden or traversal segments.", "Select a .js or .mjs entrypoint.", "Use a plain exact path.",
  "Use an exact HTTPS origin; private HTTP requires explicit literal IPv4 acknowledgement. Runtime DNS/address checks still apply.",
  "Dimension IDs must be unique.", "Service operations must be distinct.", "Use a JSON pointer, or an empty string for the complete result.",
  "Use a JSON pointer with ~0/~1 escaping, or the empty pointer.",
  "The exists comparator accepts only a boolean expected value; omit it to require presence.",
  "The lte/gte comparator requires an explicit finite numeric expected value.",
  "Numeric policy requires equals/lte/gte and an explicit finite numeric expected value. Units are declared, not converted.",
  "Step IDs must be distinct.", "A condition may read only an earlier step.", "Restore must name an earlier snapshot of the same service.",
  "Check IDs must be unique.", "This bounded isolated runner supports at most two concurrent cases.",
  "An isolated invocation supports at most four MiB of combined output.", "Selected isolated source files exceed eight MiB.",
  "File paths must be distinct and include the declared entrypoint.", "A single isolated invocation is bounded to 120 seconds.",
  "Expanded runs exceed the authorized maximum. Reduce cases/repetitions or explicitly increase maxRuns.",
  "IDs must be unique.", "Service aliases must be unique; two aliases may still use the same build.",
  "Dataset override must name a service alias in this recipe.", "Step must use a declared service alias and allowed operation.",
]);
const messages: Record<string, string> = {
  invalid_type: "Value has the wrong type or is missing.", invalid_value: "Value must match an allowed schema option.",
  invalid_format: "Value does not match the required format.", too_small: "Value is below the required minimum.",
  too_big: "Value exceeds the allowed maximum.", unrecognized_keys: "Remove unsupported fields from this object.",
  invalid_union: "Value does not match a supported schema variant.", invalid_key: "A record key is invalid.",
  invalid_element: "A collection element is invalid.", custom: "Value does not satisfy a definition constraint.",
};

export function validationDiagnostics(issues: ReadonlyArray<SchemaIssue>): ValidationDiagnostics {
  const entries: ValidationIssue[] = issues.slice(0, 20).map(issue => {
    let redact = false;
    const path = issue.path.slice(0, 20).map(part => {
      if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) return part;
      const safe = !redact && typeof part === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(part) ? part : "<key>";
      if (typeof part === "string" && dataBranches.has(part)) redact = true;
      return safe;
    });
    const code = /^[a-z_]{1,64}$/.test(issue.code) ? issue.code : "invalid_value";
    const expected = typeof issue.expected === "string" && ["string", "number", "boolean", "object", "array", "null", "int"].includes(issue.expected) ? issue.expected : undefined;
    const message = (code === "custom" && issue.message && staticConstraints.has(issue.message) ? issue.message
      : code === "invalid_type" && expected ? `Expected ${expected}.` : messages[code] ?? "Invalid definition value.").slice(0, 256);
    return { path, code, message, ...(issue.path.length > 20 ? { pathTruncated: true as const } : {}) };
  });
  return { issues: entries, totalIssues: issues.length, omittedIssues: issues.length - entries.length };
}

export function validationMessage(summary: string, validation: ValidationDiagnostics): string {
  const display = (path: Array<string | number>) => path.reduce<string>((text, part) => typeof part === "number" ? `${text}[${part}]` : `${text ? `${text}.` : ""}${part}`, "") || "$";
  const detail = validation.issues.slice(0, 3).map(issue => `${display(issue.path)}: ${issue.message}`).join("; ");
  return `${summary}${detail ? ` ${detail}` : ""}${validation.totalIssues > 3 ? `; ${validation.totalIssues - 3} additional issue(s).` : ""}`;
}

/** Check only the transport envelope; this does not validate a recipe again. */
export function readValidationDiagnostics(value: unknown): ValidationDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["issues", "totalIssues", "omittedIssues"].includes(key)) || !Array.isArray(raw.issues) || raw.issues.length > 20 ||
    !Number.isSafeInteger(raw.totalIssues) || Number(raw.totalIssues) < 0 || !Number.isSafeInteger(raw.omittedIssues) || Number(raw.omittedIssues) < 0 ||
    raw.totalIssues !== raw.issues.length + Number(raw.omittedIssues)) return;
  const issues: ValidationIssue[] = [];
  for (const item of raw.issues) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["path", "code", "message", "pathTruncated"].includes(key)) ||
      !Array.isArray(item.path) || item.path.length > 20 || item.path.some((part: unknown) => typeof part === "number" ? !Number.isSafeInteger(part) || part < 0 : typeof part !== "string" || !(part === "<key>" || /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(part))) ||
      typeof item.code !== "string" || !/^[a-z_]{1,64}$/.test(item.code) || typeof item.message !== "string" || item.message.length > 256 || /[\x00-\x1f\x7f]/.test(item.message) ||
      item.pathTruncated !== undefined && item.pathTruncated !== true) return;
    issues.push({ path: [...item.path], code: item.code, message: item.message, ...(item.pathTruncated ? { pathTruncated: true } : {}) });
  }
  return { issues, totalIssues: Number(raw.totalIssues), omittedIssues: Number(raw.omittedIssues) };
}

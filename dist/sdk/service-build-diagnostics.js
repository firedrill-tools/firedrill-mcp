/** Public diagnostic transport only; private compiler code is never a dependency. */
export const SERVICE_BUILD_DIAGNOSTICS_VERSION = "2026-10-17-service-build-diagnostics.1";
const codes = new Set(["SOURCE_SYNTAX", "SOURCE_IMPORT_DENIED", "SOURCE_IMPORT_UNRESOLVED", "SOURCE_BOUNDARY", "SOURCE_LIMIT", "SOURCE_EXTENSION", "SOURCE_COMPILE"]);
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
/** Discard unknown/raw exception fields instead of echoing a provider response. */
export function readServiceBuildFailure(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const source = value;
    if (source.schemaVersion !== SERVICE_BUILD_DIAGNOSTICS_VERSION || source.code !== "FD_SERVICE_BUILD_FAILED" || typeof source.truncated !== "boolean" || !Array.isArray(source.diagnostics) || !source.diagnostics.length || source.diagnostics.length > 12)
        return null;
    const diagnostics = [];
    for (const item of source.diagnostics) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !codes.has(item.code) || !text(item.message, 512) || !text(item.repair, 2048))
            return null;
        if (item.file !== undefined && (typeof item.file !== "string" || item.file.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:ts|js|mjs)$/.test(item.file) || item.file.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))))
            return null;
        if ([item.line, item.column].some(location => location !== undefined && (!item.file || !Number.isSafeInteger(location) || location < 1 || location > 1048576)))
            return null;
        diagnostics.push({ code: item.code, message: item.message, repair: item.repair,
            ...(item.file === undefined ? {} : { file: item.file }), ...(item.line === undefined ? {} : { line: item.line }), ...(item.column === undefined ? {} : { column: item.column }) });
    }
    return { schemaVersion: SERVICE_BUILD_DIAGNOSTICS_VERSION, code: "FD_SERVICE_BUILD_FAILED", diagnostics, truncated: source.truncated };
}
export function readServiceBuildErrorDetails(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const details = value, failure = readServiceBuildFailure(details.failure);
    const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
    return { ...(identifier(details.buildId) ? { buildId: details.buildId } : {}),
        ...(identifier(details.operationId) ? { operationId: details.operationId } : {}), ...(failure ? { failure } : {}) };
}

import { FiredrillError } from "../sdk/index.js";
// Read-only is a dispatch boundary, not only an MCP annotation. These POSTs
// compute authorized projections/previews without allocation or retained writes.
const readOnlyPosts = new Set([
    "/v1/recipes/preview", "/v1/recipes/materialize", "/v1/comparisons",
    "/v1/data-removals/preview",
]);
export function assertReadOnlyRequest(readonly, method, resourcePath) {
    if (!readonly)
        return;
    const pathname = resourcePath.split("?", 1)[0];
    if (method === "GET" || method === "POST" && readOnlyPosts.has(pathname))
        return;
    throw new FiredrillError("FD_MCP_READ_ONLY", "This Firedrill MCP connection is read-only.", "Use the existing inspection tools. A mutation requires a separately authorized writable connection; no request was dispatched.");
}

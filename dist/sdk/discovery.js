import { AUTHORING_SCHEMA_IDS, CONTRACT_VERSION, DISCOVERY_VERSION } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
export function authoringSchemaPath(id, options = {}) {
    if (!AUTHORING_SCHEMA_IDS.includes(id) || !options || typeof options !== "object" || Array.isArray(options)
        || Object.keys(options).some(key => !["pointer", "sha256"].includes(key)))
        throw new FiredrillError("SCHEMA_INPUT_INVALID", "Select an advertised schema ID and optional pointer/sha256 only.", "Read client.discover() first; no request was sent.");
    const { pointer = "", sha256 } = options;
    if (typeof pointer !== "string" || pointer.length > 2048 || pointer !== "" && !pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)
        || Buffer.from(pointer, "utf8").toString("utf8") !== pointer
        || sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)))
        throw new FiredrillError("SCHEMA_INPUT_INVALID", "Use an exact RFC 6901 pointer and the prior root SHA-256 when selecting a schema node.", "Start with an empty pointer for the complete schema; no request was sent.");
    const query = new URLSearchParams();
    if (pointer !== "")
        query.set("pointer", pointer);
    if (sha256 !== undefined)
        query.set("sha256", sha256);
    return `/v1/discovery/schemas/${id}${query.size ? `?${query}` : ""}`;
}
/** Metadata incompatibility is not permission to probe support with a mutation. */
export function requireDiscoveryVersion(value) {
    if (!value || value.schemaVersion !== DISCOVERY_VERSION || value.contractVersion !== CONTRACT_VERSION)
        throw new FiredrillError("FD_DISCOVERY_INCOMPATIBLE", "The selected service advertises a discovery/recipe version this client does not support.", "Update the client explicitly from the selected service's installation guide. Do not silently downgrade a recipe or allocate work to probe compatibility.");
    return value;
}

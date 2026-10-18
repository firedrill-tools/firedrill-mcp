import { createHash } from "node:crypto";
import { OPERATOR_DOCUMENT_VERSION } from "../contracts/index.js";
const serialized = (value) => JSON.stringify(value ?? null);
const bytes = (value) => Buffer.byteLength(serialized(value));
const pointerKey = (key) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const valueType = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
function omitted(value, pointer) {
    const text = serialized(value);
    return { omitted: true, pointer, valueType: valueType(value), totalBytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        ...(Array.isArray(value) ? { totalItems: value.length } : {}) };
}
// This is presentation, not truncation of the retained resource. Every replaced
// value carries its exact JSON Pointer in the authenticated response below.
function metadata(value, pointer, budget, depth = 0) {
    if (bytes(value) <= budget)
        return value;
    if (!value || typeof value !== "object" || depth >= 6)
        return omitted(value, pointer);
    const entries = Object.entries(value);
    if (!entries.length || entries.length > 64)
        return omitted(value, pointer);
    const allowance = Math.floor((budget - 2048) / entries.length);
    if (allowance < 384)
        return omitted(value, pointer);
    const selected = entries.map(([key, item]) => [key, metadata(item, `${pointer}/${pointerKey(key)}`, allowance, depth + 1)]);
    const projected = Array.isArray(value)
        ? { projection: "array-metadata", totalItems: value.length, items: selected.map(([index, item]) => ({ index: Number(index), value: item })) }
        : Object.fromEntries(selected);
    return bytes(projected) <= budget ? projected : omitted(value, pointer);
}
function populationFacts(value, depth = 0) {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth >= 6)
        return {};
    const item = value;
    const facts = {};
    for (const key of ["schemaVersion", "id", "revision", "batchId", "projectId", "environmentId", "scope", "snapshotAt", "counts", "countsScope", "pairingScope", "groupPage", "dimensionPage", "nextCursor", "total", "lifecycle"])
        if (Object.hasOwn(item, key))
            facts[key] = item[key];
    // Preserve service-owned counts when a large operator document needs another
    // presentation bound. Do not count only its displayed metric/check samples.
    if (item.projection === OPERATOR_DOCUMENT_VERSION && item.value && typeof item.value === "object" && !Array.isArray(item.value)) {
        facts.document = populationFacts(item.value, depth + 1);
        facts.resource = item.resource;
    }
    if (item.assessment && typeof item.assessment === "object" && !Array.isArray(item.assessment)) {
        const assessment = item.assessment;
        facts.assessment = Object.fromEntries(["state", "checkCounts", "checkPage", "metricCounts", "metricPage"]
            .filter(key => Object.hasOwn(assessment, key)).map(key => [key, assessment[key]]));
    }
    for (const key of ["baseline", "candidate"]) {
        const side = item[key];
        if (side && typeof side === "object" && !Array.isArray(side))
            facts[key] = populationFacts(side, depth + 1);
    }
    if (item.pairing && typeof item.pairing === "object" && !Array.isArray(item.pairing)) {
        const { samples: _, ...pairing } = item.pairing;
        facts.pairing = pairing;
    }
    return facts;
}
/** Ordinary small responses stay compatible; large pages retain exact read handles. */
export function inspectionOutput(value, read, completedMutation) {
    if (bytes(value) <= 100000)
        return value;
    const facts = populationFacts(value);
    return {
        projection: "mcp-inspection-metadata-2026-10-15.1",
        facts: bytes(facts) <= 16000 ? facts : { omitted: true, note: "Population facts exceed this presentation bound; read the original authorized resource." },
        value: metadata(value, "", 64000),
        resource: { method: read.method, path: read.path, ...(read.body ? { body: read.body } : {}), authenticated: true,
            ...(typeof read.arguments.projectId === "string" && typeof read.arguments.environmentId === "string"
                ? { selectedScope: { projectId: read.arguments.projectId, environmentId: read.arguments.environmentId } } : {}) },
        request: { tool: read.tool, arguments: read.arguments },
        ...(completedMutation ? { receipt: { action: completedMutation, confirmed: true, followUpIsReadOnly: true } } : {}),
        representation: {
            completeResourceIncluded: false,
            hashSerialization: "UTF-8 JSON.stringify of the selected API response value",
            note: "Omitted values remain in the authorized API response at their exact JSON Pointers. Array metadata includes explicit original indices, never an invented page. Counts and cursors describe the service response, not the amount shown. Reads may reflect later state; do not combine changed snapshots as one result. " +
                (completedMutation ? "The mutation succeeded; these are read-only follow-ups to its retained receipt, not instructions to repeat it. This presentation does not confirm target completion or assessment success." : "No target or evaluator was invoked."),
        },
    };
}

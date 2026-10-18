import { JsonSchema } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
export function checkedMetrics(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["latencyMs", "modelUsage"].includes(key)))
        throw invalid();
    const numeric = (value, integer = false) => typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value));
    if (input.latencyMs !== undefined && !numeric(input.latencyMs))
        throw invalid();
    const usage = input.modelUsage;
    if (usage !== undefined) {
        if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.keys(usage).some(key => !["provider", "model", "inputTokens", "outputTokens", "costUsd"].includes(key)))
            throw invalid();
        for (const key of ["inputTokens", "outputTokens", "costUsd"])
            if (usage[key] !== undefined && !numeric(usage[key], key !== "costUsd"))
                throw invalid();
        for (const key of ["provider", "model"])
            if (usage[key] !== undefined && (typeof usage[key] !== "string" || !usage[key].trim() || usage[key].length > 200 || /[\x00-\x1f\x7f]/.test(usage[key])))
                throw invalid();
    }
    JsonSchema.parse(input);
    return JSON.parse(JSON.stringify(input));
}
function invalid() { return new FiredrillError("TARGET_METRICS_INVALID", "Target measurements must be explicit finite nonnegative values; tokens must be integers.", "Record observed latencyMs and modelUsage fields only. Omit unknown measurements rather than reporting zero."); }
export function metricsJson(value) { return JSON.parse(JSON.stringify(value)); }

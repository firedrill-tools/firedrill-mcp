import { JsonSchema, type Json } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";

/** Explicit customer measurements, never platform estimates or provider instrumentation. */
export interface TargetMetrics {
  latencyMs?: number;
  modelUsage?: { provider?: string; model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
}
export function checkedMetrics(input: TargetMetrics): TargetMetrics {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["latencyMs", "modelUsage"].includes(key))) throw invalid();
  const numeric = (value: unknown, integer = false) => typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value));
  if (input.latencyMs !== undefined && !numeric(input.latencyMs)) throw invalid();
  const usage = input.modelUsage;
  if (usage !== undefined) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.keys(usage).some(key => !["provider", "model", "inputTokens", "outputTokens", "costUsd"].includes(key))) throw invalid();
    for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) if (usage[key] !== undefined && !numeric(usage[key], key !== "costUsd")) throw invalid();
    for (const key of ["provider", "model"] as const) if (usage[key] !== undefined && (typeof usage[key] !== "string" || !usage[key]!.trim() || usage[key]!.length > 200 || /[\x00-\x1f\x7f]/.test(usage[key]!))) throw invalid();
  }
  JsonSchema.parse(input);
  return JSON.parse(JSON.stringify(input)) as TargetMetrics;
}
function invalid() { return new FiredrillError("TARGET_METRICS_INVALID", "Target measurements must be explicit finite nonnegative values; tokens must be integers.", "Record observed latencyMs and modelUsage fields only. Omit unknown measurements rather than reporting zero."); }
export function metricsJson(value: TargetMetrics): Record<string, Json> { return JSON.parse(JSON.stringify(value)) as Record<string, Json>; }

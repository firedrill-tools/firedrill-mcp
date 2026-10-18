import type { BatchResult, GateState } from "../contracts/index.js";

const executionStates = ["queued", "running", "completed", "error", "interrupted", "cancelled"] as const;
const assessmentStates = ["not_requested", "pending", "completed", "partial", "unavailable", "error"] as const;
const gateStates = ["not_configured", "allow", "block", "inconclusive"] as const;

/** One exit convention for CLI and customer-owned SDK runners. A zero exit with
 * no gate means execution completed, never that the agent was judged correct. */
export function simulationExitCode(result: BatchResult): number {
  if (!Number.isSafeInteger(result.batch.total) || result.batch.total < 0 ||
      !executionStates.every(state => Number.isSafeInteger(result.batch.counts[state]) && result.batch.counts[state] >= 0) ||
      executionStates.reduce((sum, state) => sum + result.batch.counts[state], 0) !== result.batch.total ||
      !gateStates.includes(result.gate)) return 5;
  if (["block", "inconclusive"].includes(result.gate)) return 1;
  if (result.assessmentCounts) {
    if (!assessmentStates.every(state => Number.isSafeInteger(result.assessmentCounts![state]) && result.assessmentCounts![state] >= 0) ||
        assessmentStates.reduce((sum, state) => sum + result.assessmentCounts![state], 0) !== result.batch.total) return 5;
    if (result.assessmentCounts.pending > 0) return 6;
  } else if (result.runs.some(run => run.assessment === "pending")) return 6;
  if (result.batch.counts.interrupted || result.batch.counts.cancelled || result.batch.counts.running || result.batch.counts.queued) return 6;
  return result.batch.counts.error ? 5 : 0;
}

/** Do not count a compact result's first page as the whole population. */
export function simulationGateCounts(result: BatchResult): Record<GateState, number> | null {
  const supplied = result.gateCounts;
  if (supplied && gateStates.every(state => Number.isSafeInteger(supplied[state]) && supplied[state] >= 0) &&
      gateStates.reduce((sum, state) => sum + supplied[state], 0) === result.batch.total) return { ...supplied };
  if (result.runs.length !== result.batch.total || new Set(result.runs.map(run => run.id)).size !== result.batch.total ||
      result.pagination && (!result.pagination.complete || result.pagination.nextCursor !== null || result.pagination.total !== result.batch.total) ||
      !result.runs.every(run => run.batchId === result.batch.id && run.projectId === result.batch.projectId &&
        run.environmentId === result.batch.environmentId && gateStates.includes(run.gate))) return null;
  const counts: Record<GateState, number> = { allow: 0, block: 0, inconclusive: 0, not_configured: 0 };
  for (const run of result.runs) counts[run.gate]++;
  return counts;
}

export function simulationCiStatus(result: BatchResult): string {
  if (result.gate === "block") return "Failed";
  if (result.gate === "inconclusive") return "Needs review";
  if (result.batch.counts.queued || result.batch.counts.running || result.assessmentCounts?.pending ||
      !result.assessmentCounts && result.runs.some(run => run.assessment === "pending")) return "In progress";
  if (result.batch.counts.error) return "Execution error";
  if (result.batch.counts.interrupted) return "Interrupted";
  if (result.batch.counts.cancelled) return "Cancelled";
  return result.gate === "allow" && result.batch.total > 0 ? "Passed" : "Completed — no pass/fail gate";
}

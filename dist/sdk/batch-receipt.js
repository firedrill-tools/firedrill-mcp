import { BATCH_RECEIPT_VERSION } from "../contracts/index.js";
import { simulationGateCounts } from "./simulation-exit.js";
export { BATCH_RECEIPT_VERSION } from "../contracts/index.js";
const assessmentStates = ["not_requested", "pending", "completed", "partial", "unavailable", "error"];
const note = "This receipt does not infer success. Execution, assessment and gate remain separate. runSample is not a page; use reads for the full retained population and evidence.";
/** Present an existing result without copying its recipe, outputs or evidence.
 * Pure local projection: no target invocation, evaluation, follow-up read or mutation. */
export function batchReceipt(result) {
    const { batch, runs, pagination } = result;
    const fullCoverage = Number.isSafeInteger(batch.total) && batch.total >= 0 && runs.length === batch.total
        && (pagination === undefined || pagination.complete === true && pagination.total === batch.total && pagination.nextCursor === null)
        && new Set(runs.map(run => run.id)).size === batch.total
        && runs.every(run => run.batchId === batch.id && run.projectId === batch.projectId
            && run.environmentId === batch.environmentId && assessmentStates.includes(run.assessment));
    let assessmentCounts = null;
    if (result.assessmentCounts && assessmentStates.every(state => Number.isSafeInteger(result.assessmentCounts[state])
        && result.assessmentCounts[state] >= 0)
        && assessmentStates.reduce((total, state) => total + result.assessmentCounts[state], 0) === batch.total) {
        assessmentCounts = Object.fromEntries(assessmentStates.map(state => [state, result.assessmentCounts[state]]));
    }
    else if (fullCoverage) {
        assessmentCounts = { not_requested: 0, pending: 0, completed: 0, partial: 0, unavailable: 0, error: 0 };
        for (const run of runs)
            assessmentCounts[run.assessment]++;
    }
    const runSample = runs.slice(0, 10).map(run => ({
        id: run.id, scenarioId: run.scenario.id, configurationId: run.configuration.id,
        repetition: run.repetition, execution: run.execution, assessment: run.assessment, gate: run.gate,
    }));
    const path = `/v1/batches/${encodeURIComponent(batch.id)}`;
    return {
        schemaVersion: BATCH_RECEIPT_VERSION,
        batch: {
            id: batch.id, projectId: batch.projectId, environmentId: batch.environmentId,
            name: batch.name, createdAt: batch.createdAt, cancellationRequested: batch.cancellationRequested,
            total: batch.total,
            counts: { queued: batch.counts.queued, running: batch.counts.running, completed: batch.counts.completed,
                error: batch.counts.error, interrupted: batch.counts.interrupted, cancelled: batch.counts.cancelled },
            charge: { amount: batch.charge.amount, policy: batch.charge.policy },
        },
        gate: result.gate,
        ...(result.operationId === undefined ? {} : { operationId: result.operationId }),
        ...(result.ciReport === undefined ? {} : { ciReport: result.ciReport }),
        ...(result.lifecycle === undefined ? {} : { lifecycle: result.lifecycle }),
        assessmentCounts, gateCounts: simulationGateCounts(result), reportUrl: result.reportUrl, runSample,
        sample: { returned: runSample.length, total: batch.total, complete: fullCoverage && runSample.length === batch.total,
            kind: "first_retained_runs_not_a_page" },
        reads: { batch: `${path}?view=operator`, runs: `${path}/runs`, summary: `${path}/summary?view=operator` },
        note,
    };
}

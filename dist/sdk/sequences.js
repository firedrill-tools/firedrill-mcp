import { setTimeout as delay } from "node:timers/promises";
import { FiredrillError } from "./errors.js";
import { event, executeTarget } from "./targets.js";
import { redactToolSecrets } from "./run-tools.js";
import { liveEvents, flushLiveEvents } from "./live-events.js";
export async function executeSequence(options) {
    const { work, save, target, signal, attach, request } = options;
    const claim = work.claim, lease = { attemptId: claim.attemptId, leaseToken: claim.leaseToken };
    const base = `/v1/runs/${encodeURIComponent(claim.run.id)}`;
    for (;;) {
        if (work.sequenceStep?.phase === "running") {
            await flushLiveEvents(work, save, events => request(`${base}/events`, { ...lease, events }));
            throw new FiredrillError("EXECUTION_UNCERTAIN", "This sequence target step may already have executed and will not be invoked again.", "Inspect the retained sequence and reconcile the customer process. Starting a new operation is not recovery.", { runId: claim.run.id, stepId: work.sequenceStep.stepId, uncertain: true });
        }
        if (work.sequenceStep?.phase === "complete") {
            for (let offset = 0; offset < work.sequenceStep.events.length; offset += 16)
                await request(`${base}/events`, { ...lease, events: work.sequenceStep.events.slice(offset, offset + 16) });
            await request(`${base}/sequence/complete`, { ...lease, completion: work.sequenceStep.completion });
            if (work.sequenceStep.stopUnconfirmed) {
                // Keep the completed marker until outer finalization is journaled. A
                // recovery can retain these same bytes but never dispatch a next step.
                const completion = work.sequenceStep.completion;
                return { execution: "interrupted", output: completion.output, reason: completion.reason,
                    metrics: completion.metrics, stopUnconfirmed: true,
                    events: [event("runner.sequence_stopped", { stepId: work.sequenceStep.stepId, reason: "target_stop_unconfirmed", provenance: "adapter_observed" })] };
            }
            delete work.sequenceStep;
            delete work.liveEvents;
            save();
        }
        if (signal.aborted)
            return { execution: String(signal.reason).includes("CANCELLED") ? "cancelled" : "interrupted", output: null,
                reason: "Sequence stopped; no further step is dispatched.", metrics: {}, events: [event("runner.sequence_stopped", { reason: "caller_or_authority_stop" })] };
        const next = await request(`${base}/sequence/next`, lease);
        if (next.state === "finished")
            return { execution: next.execution, output: next.output, reason: next.reason, metrics: next.metrics,
                events: [event("runner.sequence_retained", { invocation: "customer_owned", authority: "declared_steps", steps: next.metrics.sequenceSteps ?? null })] };
        if (signal.aborted)
            return { execution: String(signal.reason).includes("CANCELLED") ? "cancelled" : "interrupted", output: null,
                reason: "Sequence stopped; no further target invocation is attempted.", metrics: {}, events: [event("runner.sequence_stopped", { stepId: next.stepId })] };
        if (next.state === "wait") {
            await delay(Math.min(60000, next.waitMs), undefined, { signal }).catch(() => { });
            continue;
        }
        if (next.state === "advance")
            continue;
        let remaining = Date.parse(next.deadline) - Date.now();
        if (remaining <= 0)
            continue;
        // A reset rotates service epochs. Refresh only metadata/grants from the same
        // prepared bindings; do not persist those credentials in the recovery journal.
        const tools = await options.tools();
        if (signal.aborted)
            continue;
        remaining = Date.parse(next.deadline) - Date.now();
        if (remaining <= 0)
            continue;
        work.sequenceStep = { ordinal: next.ordinal, stepId: next.stepId, phase: "running" };
        save();
        const stepClaim = { ...claim, run: { ...claim.run, scenario: { ...claim.run.scenario, input: next.input } },
            limits: { ...claim.limits, timeoutMs: Math.max(1, Math.min(remaining, claim.limits.timeoutMs, claim.run.target.kind === "isolated_node" ? 120000 : Infinity)), maxOutputBytes: Math.min(128 * 1024, claim.limits.maxOutputBytes) } };
        const step = { ordinal: next.ordinal, id: next.stepId };
        const stream = claim.run.target.kind === "native" ? liveEvents(work, save, events => request(`${base}/events`, { ...lease, events })) : undefined;
        let outcome;
        try {
            outcome = redactToolSecrets(await executeTarget(stepClaim, target, signal, attach, tools, step, options.isolated ? { binding: options.isolated.binding, onPrepared: path => options.isolated.onPrepared(path, stepClaim, step) } : undefined, stream ? item => stream.record(redactToolSecrets({ ...item, payload: { stepId: next.stepId, ordinal: next.ordinal, observation: item.payload } }, tools)) : undefined), tools);
            if (outcome.stopUnconfirmed) {
                work.stopUnconfirmed = true;
                work.sequenceStep.stopUnconfirmed = true;
                options.onStopUnconfirmed?.();
                save(); // Preserve uncertainty even if live evidence settlement rejects.
            }
        }
        finally {
            await stream?.settle();
        }
        work.sequenceStep = { ordinal: next.ordinal, stepId: next.stepId, phase: "complete",
            completion: { ordinal: next.ordinal, execution: outcome.execution, output: outcome.output, reason: outcome.reason, metrics: outcome.metrics },
            events: outcome.events.map(item => ({ ...item, payload: { stepId: next.stepId, ordinal: next.ordinal, observation: item.payload } })),
            ...(outcome.stopUnconfirmed ? { stopUnconfirmed: true } : {}) };
        if (work.isolatedReceipt)
            work.isolatedReceipt.settled = true;
        if (outcome.stopUnconfirmed)
            work.stopUnconfirmed = true;
        save();
        if (outcome.stopUnconfirmed)
            options.onStopUnconfirmed?.();
    }
}

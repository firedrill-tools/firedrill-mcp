import { RESULT_LIFECYCLE_VERSION } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
/** Client observation envelope; does not change the retained service contract. */
export const FOLLOW_VERSION = "2026-10-16-follow.1";
const states = ["queued", "running", "completed", "error", "interrupted", "cancelled"];
const assessments = ["not_requested", "pending", "completed", "partial", "unavailable", "error"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const wholeCounts = (value, names, total) => record(value) && names.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) && names.reduce((sum, key) => sum + value[key], 0) === total;
const repair = "Follow this same batch with its original authorized project/environment, or inspect its retained result. This observer did not request target execution, cancellation or assessment.";
/** Reusable read-only coordinator for native SDK and operator MCP. */
export async function followBatch(batchId, reader, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options))
        throw new FiredrillError("FOLLOW_OPTIONS_INVALID", "Follow options must be an object.", "Use timeoutMs, pollIntervalMs and an optional AbortSignal. No request was sent.");
    const timeoutMs = options.timeoutMs ?? 300000, interval = options.pollIntervalMs ?? 1000;
    if (!identifier(batchId) || !identifier(reader.scope.projectId) || !identifier(reader.scope.environmentId)
        || Object.keys(options).some(key => !["timeoutMs", "pollIntervalMs", "signal"].includes(key))
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3600000
        || !Number.isSafeInteger(interval) || interval < 250 || interval > 30000
        || options.signal !== undefined && !(options.signal instanceof AbortSignal))
        throw new FiredrillError("FOLLOW_OPTIONS_INVALID", "Follow needs an exact batch and scope, timeoutMs 0–3600000 and pollIntervalMs 250–30000.", "Select the original batch scope; timeoutMs 0 reads one snapshot. No request was sent.");
    // Zero requests one snapshot, not an unbounded series of transport waits.
    const scope = { ...reader.scope }, started = performance.now(), deadline = started + (timeoutMs === 0 ? 30000 : timeoutMs);
    // Compact carries authoritative whole-population assessment counts. Ordinary
    // full results from older services do not necessarily include that coverage.
    const path = `/v1/batches/${encodeURIComponent(batchId)}/result?compact=1`;
    let identity;
    let last, observedAt = "", polls = 0;
    const stopReason = () => options.signal?.aborted ? "interrupted" : performance.now() >= deadline ? "timeout" : undefined;
    const receipt = (state, error) => {
        if (!last)
            throw new FiredrillError("FOLLOW_UNCONFIRMED", "Observation ended before a batch snapshot was confirmed.", repair, { batchId, ...(error ? { causeCode: error.code } : {}), validation: { observationState: state, scope } });
        return { schemaVersion: FOLLOW_VERSION, observation: { state, readOnly: true,
                snapshotObservedAt: observedAt, snapshotTimeSource: "client_read_completed", elapsedMs: Math.max(0, Math.round(performance.now() - started)), polls,
                continuation: { batchId, ...scope }, ...(error ? { error } : {}),
                note: state === "settled" ? "Execution and whole-population assessment are terminal in this snapshot, not necessarily successful. This is not proof of customer-target stop or all resource cleanup."
                    : "Last confirmed snapshot, not a current completion claim. Only observation stopped; customer execution and assessment may continue. An in-flight authenticated read may finish under its transport bound." }, result: last };
    };
    // A late read can finish, but its result is never adopted after observation ends.
    // No callback here claims work, uploads evidence, writes a journal or starts CI reporting.
    const bounded = async (action) => {
        const stopped = stopReason();
        if (stopped)
            return { stopped };
        let timer, interrupt;
        try {
            return await Promise.race([action().then(value => ({ value })), new Promise(resolve => {
                    interrupt = () => resolve({ stopped: "interrupted" });
                    options.signal?.addEventListener("abort", interrupt, { once: true });
                    if (options.signal?.aborted)
                        interrupt();
                    timer = setTimeout(() => resolve({ stopped: "timeout" }), Math.max(0, deadline - performance.now()));
                })]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (interrupt)
                options.signal?.removeEventListener("abort", interrupt);
        }
    };
    const requireContext = (value) => {
        const principal = record(value) && record(value.principal) ? value.principal : undefined;
        if (!principal || !identifier(principal.id) || !identifier(principal.organizationId)
            || !Array.isArray(principal.capabilities) || !principal.capabilities.includes("read")
            || !(principal.projectIds === null || Array.isArray(principal.projectIds) && principal.projectIds.includes(scope.projectId))
            || !(principal.environmentIds === null || Array.isArray(principal.environmentIds) && principal.environmentIds.includes(scope.environmentId)))
            throw new FiredrillError("FOLLOW_SCOPE_UNCONFIRMED", "The current identity did not confirm read authority for the selected scope.", repair, { batchId });
        if (identity && (identity.id !== principal.id || identity.organizationId !== principal.organizationId))
            throw new FiredrillError("FOLLOW_IDENTITY_CHANGED", "The observer's identity or organization changed.", repair, { batchId });
        identity ??= { id: principal.id, organizationId: principal.organizationId };
    };
    for (;;) {
        try {
            const context = await bounded(() => reader.read("/v1/context"));
            if ("stopped" in context)
                return receipt(context.stopped);
            requireContext(context.value);
            const response = await bounded(() => reader.read(path));
            if ("stopped" in response)
                return receipt(response.stopped);
            const value = response.value;
            if (!record(value) || !record(value.batch) || value.batch.id !== batchId
                || value.batch.projectId !== scope.projectId || value.batch.environmentId !== scope.environmentId)
                throw new FiredrillError("FOLLOW_SCOPE_UNCONFIRMED", "The retained result did not confirm this batch and selected scope.", repair, { batchId });
            if (!Number.isSafeInteger(value.batch.total) || value.batch.total < 0 || !wholeCounts(value.batch.counts, states, value.batch.total)
                || !Array.isArray(value.runs) || typeof value.reportUrl !== "string")
                throw new FiredrillError("FOLLOW_RESPONSE_UNCONFIRMED", "The retained response did not contain coherent batch counts and references.", repair, { batchId });
            last = value;
            observedAt = new Date().toISOString();
            polls++;
            const complete = value.batch.counts.queued === 0 && value.batch.counts.running === 0
                && wholeCounts(value.assessmentCounts, assessments, value.batch.total) && value.assessmentCounts.pending === 0;
            const stopped = stopReason();
            if (stopped)
                return receipt(stopped);
            if (complete)
                return receipt("settled");
            if (timeoutMs === 0)
                return receipt("timeout");
            let sleepTimer;
            try {
                const sleep = await bounded(() => new Promise(resolve => { sleepTimer = setTimeout(resolve, Math.min(interval, Math.max(0, deadline - performance.now()))); }));
                if ("stopped" in sleep)
                    return receipt(sleep.stopped);
            }
            finally {
                if (sleepTimer)
                    clearTimeout(sleepTimer);
            }
        }
        catch (error) {
            if (error instanceof FiredrillError) {
                if (/^FD_CONTENT_(?:UNAVAILABLE|EXPIRED|DELETED|DELETION_PENDING)$/.test(error.code)) {
                    try {
                        const metadata = await bounded(() => reader.read(`/v1/batches/${encodeURIComponent(batchId)}/lifecycle`));
                        if ("value" in metadata) {
                            const value = metadata.value;
                            if (record(value) && value.schemaVersion === RESULT_LIFECYCLE_VERSION && value.batchId === batchId
                                && value.projectId === scope.projectId && value.environmentId === scope.environmentId
                                && record(value.lifecycle) && value.lifecycle.schemaVersion === RESULT_LIFECYCLE_VERSION)
                                error.details.retainedLifecycle = value;
                        }
                    }
                    catch { /* Metadata failure never replaces the original payload rejection. */ }
                    error.details.batchId = batchId;
                    throw error;
                }
                // Rejected reads, loss of access, retention changes and identity/scope
                // conflicts are not ordinary polling interruption. Do not serve stale data.
                if (error.details.status !== undefined && error.details.status >= 400 && error.details.status < 500 && error.details.status !== 408 && error.details.status !== 429
                    || /AUTH|IDENTITY|LOGIN|SCOPE|PERMISSION|DENIED|RETAIN|REMOV|DELET|EXPIRED|NOT_FOUND|RESPONSE_UNCONFIRMED|FOLLOW_UNCONFIRMED/i.test(error.code)) {
                    error.details.batchId = batchId;
                    throw error;
                }
            }
            return receipt("read_error", { code: error instanceof FiredrillError ? error.code : "FOLLOW_READ_UNCONFIRMED", repair });
        }
    }
}

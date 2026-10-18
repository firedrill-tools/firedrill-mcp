import { RUN_INTERVENTION_VERSION, RUN_CLOCK_INTERVENTION_VERSION, RunInterventionSchema } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";
function runId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
        throw new FiredrillError("RUN_ID_INVALID", "Choose a retained run ID.", "Read the current batch's runs before selecting an intervention.");
    return encodeURIComponent(value);
}
/** Explicit operator controls, separate from the customer's target credentials. */
export class FiredrillInterventions {
    scope;
    request;
    constructor(scope, request) {
        this.scope = scope;
        this.request = request;
    }
    controls(selectedRunId) {
        return this.request("GET", `/v1/runs/${runId(selectedRunId)}/services?${new URLSearchParams(this.scope())}`);
    }
    list(selectedRunId, options = {}) {
        const { cursor = 0, limit = 25 } = options;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new FiredrillError("PAGE_INVALID", "Use a nonnegative returned cursor and limit 1–100.", "Follow nextCursor without changing the run or selected scope.");
        const query = new URLSearchParams({ ...this.scope(), cursor: String(cursor), limit: String(limit) });
        return this.request("GET", `/v1/runs/${runId(selectedRunId)}/interventions?${query}`);
    }
    async apply(selectedRunId, input, operationKey) {
        const selected = runId(selectedRunId);
        if (typeof operationKey !== "string" || !operationKey.trim() || operationKey.length > 200 || /[\r\n]/.test(operationKey))
            throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Retain a stable intervention key before dispatch.", "Reuse this exact key and unchanged input after an uncertain reply; a new key means a new intervention.");
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(name => !["service", "instanceId", "epoch", "operationId", "arguments", "reason", "action", "toUs", "maxEvents"].includes(name)))
            throw new FiredrillError("INTERVENTION_INVALID", "Supply one declared operation or an explicit clock action with its binding, epoch and reason.", "Scope comes from this client. Read the run's current services and permitted controls before dispatch.");
        const schemaVersion = "action" in input && input.action === "clock" ? RUN_CLOCK_INTERVENTION_VERSION : RUN_INTERVENTION_VERSION;
        const parsed = RunInterventionSchema.safeParse({ schemaVersion, ...this.scope(), ...input });
        if (!parsed.success)
            throw definitionError("INTERVENTION_INVALID", "The intervention input is invalid.", "Read the active binding's exact epoch and allowed control operations. No intervention was dispatched.", parsed.error.issues);
        if (Buffer.byteLength(JSON.stringify(parsed.data)) > 64 * 1024)
            throw new FiredrillError("INTERVENTION_LIMIT", "Intervention input exceeds 64 KiB.", "Supply one bounded declared control action.");
        try {
            return await this.request("POST", `/v1/runs/${selected}/interventions`, parsed.data, operationKey);
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The live intervention acknowledgement was not confirmed.", "Inspect interventions.list(runId), then reconcile with the same operation key and unchanged input. Do not issue a new key or repeat target execution.", error.details);
            throw error;
        }
    }
}

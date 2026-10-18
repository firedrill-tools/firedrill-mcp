import { createHash } from "node:crypto";
import { z } from "zod";
import { RUN_INTERVENTION_VERSION, RUN_CLOCK_INTERVENTION_VERSION, RunOperationInterventionSchema, RunClockInterventionSchema, ScopeSchema } from "../contracts/index.js";
const runId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const operationKey = z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/).describe("Retain before dispatch. Reuse this exact key and unchanged input after an uncertain reply.");
function compact(receipt) {
    const text = JSON.stringify(receipt.result), bytes = Buffer.byteLength(text);
    return { ...receipt, result: bytes <= 4096 ? receipt.result : { omitted: true, bytes, sha256: createHash("sha256").update(text).digest("hex"),
            repair: `Read the retained intervention for run ${receipt.runId} through the SDK/API. Do not repeat the operation with a new key.` } };
}
export function registerInterventionTools(server, options) {
    const { principal, request, safe } = options;
    if (principal.capabilities.includes("read"))
        server.registerTool("firedrill_interventions", {
            description: "Read retained operator interventions in one scoped run. These are not customer-target actions or new simulations. Each receipt preserves its actual complete, failed or uncertain state; follow nextCursor for more.",
            inputSchema: ScopeSchema.extend({ runId, cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(20).default(10) }).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, ({ runId: selected, cursor, limit, ...scope }) => safe(async () => {
            const result = await request("GET", `/v1/runs/${encodeURIComponent(selected)}/interventions?${new URLSearchParams({ ...scope, cursor: String(cursor), limit: String(limit) })}`);
            return { ...result, items: result.items.map(compact) };
        }));
    if (!options.readonly && principal.capabilities.includes("read") && principal.capabilities.includes("services:control") && principal.capabilities.includes("runs:execute"))
        server.registerTool("firedrill_intervene", {
            description: "Apply one explicit permitted control operation to an active run's Tool. Read run_services first for current alias, instance, epoch and controlOperations. This mutates synthetic state, consumes no target invocation and is attributed to the operator, never the target. Save exact input/key; unknown acknowledgements must be reconciled, not retried as new interventions. Arbitrary reset/clock/fault operations are not implied.",
            inputSchema: RunOperationInterventionSchema.unwrap().omit({ schemaVersion: true }).extend({ runId, operationKey }).strict(),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        }, ({ runId: selected, operationKey: key, ...body }) => safe(async () => {
            if (Buffer.byteLength(JSON.stringify({ schemaVersion: RUN_INTERVENTION_VERSION, ...body })) > 64 * 1024)
                throw Object.assign(new Error("Intervention input exceeds 64 KiB."), { publicError: { code: "INTERVENTION_LIMIT", message: "Intervention input exceeds 64 KiB; no request sent.", repair: "Supply bounded arguments for one declared control operation." } });
            const result = await request("POST", `/v1/runs/${encodeURIComponent(selected)}/interventions`, { schemaVersion: RUN_INTERVENTION_VERSION, ...body }, key);
            return { ...result, intervention: compact(result.intervention) };
        }));
    if (!options.readonly && principal.capabilities.includes("read") && principal.capabilities.includes("services:control") && principal.capabilities.includes("runs:execute"))
        server.registerTool("firedrill_advance_time", {
            description: "Advance one active run's managed Tool clock to absolute toUs, processing at most maxEvents (1–1000) scheduled events. Read run_services for explicit clockAdvance permission, current virtualTimeUs, instance and epoch first. Requires service-control.2 clock.advance in the retained recipe; invoke authority never implies clock permission. Does not advance the customer agent clock, extend wall-clock leases, rewind, or execute a target. Inspect result.reachedUs and failures: complete receipt means action recorded, not destination reached. Save input/key before dispatch; reconcile an uncertain reply with that exact key.",
            inputSchema: RunClockInterventionSchema.unwrap().omit({ schemaVersion: true, action: true }).extend({ runId, operationKey }).strict(),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        }, ({ runId: selected, operationKey: key, ...body }) => safe(async () => {
            const result = await request("POST", `/v1/runs/${encodeURIComponent(selected)}/interventions`, { schemaVersion: RUN_CLOCK_INTERVENTION_VERSION, action: "clock", ...body }, key);
            return { ...result, intervention: compact(result.intervention) };
        }));
}

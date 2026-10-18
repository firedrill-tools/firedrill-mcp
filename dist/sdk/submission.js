import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, RecipeSchema, SubmissionMetadataSchema } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";
import { readJsonInput } from "./input-files.js";
import { JournalStore } from "./journal.js";
import { matchRetainedSubmission, newSubmission } from "./ci-context.js";
export const SUBMISSION_RECEIPT_VERSION = "2026-10-16-submission.1";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "undefined";
const repair = "Reconcile only this submission with resumeSubmission(submissionKey), the original API/scope/identity and private journal directory. A submission key is not an execution operation ID; do not start another batch to recover an uncertain response.";
export class SubmissionError extends FiredrillError {
    submissionKey;
    selection;
    constructor(error, submissionKey, selection, batchId) {
        super(error.code, error.message, `${error.repair} ${repair}`, { ...error.details, workStarted: "unknown", retry: "reconcile", ...(batchId ? { batchId } : {}) });
        this.submissionKey = submissionKey;
        this.selection = selection;
    }
    toJSON() {
        const value = super.toJSON();
        return { error: { ...value.error,
                submissionKey: this.submissionKey, submissionRecovery: { ...this.selection, method: "resumeSubmission", submissionKey: this.submissionKey } } };
    }
}
function validateOptions(value, resume) {
    if (!record(value) || Object.keys(value).some(key => ![...(resume ? [] : ["idempotencyKey"]), "submissionOrigin", "ciContext"].includes(key)))
        throw new FiredrillError("SUBMISSION_OPTIONS_INVALID", "Submission accepts only its stable key and optional origin/CI declaration.", "Execution callbacks, follow settings and allowParallel belong to the later runner, not submission.");
}
function keyValue(value) {
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value))
        throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Submission needs a saved printable ASCII key of 1–200 characters without whitespace.", "Save a unique key with this recipe before submitting. Reuse it only for exact creation recovery.");
    return value;
}
function recipeValue(input) {
    const value = typeof input === "string" ? readJsonInput(input, 8 * 1024 * 1024, "RECIPE_INVALID") : input;
    const parsed = RecipeSchema.safeParse(record(value) ? { schemaVersion: CONTRACT_VERSION, ...value } : value);
    if (!parsed.success)
        throw definitionError("RECIPE_INVALID", "Submission recipe is invalid.", "Supply a complete explicit target descriptor. No callback, adapter or concurrency acknowledgement is needed until execution.", parsed.error.issues);
    return parsed.data;
}
function contextIdentity(value, context) {
    const p = record(value) && record(value.principal) ? value.principal : undefined;
    if (!p || !identifier(p.id) || !identifier(p.organizationId) || !Array.isArray(p.capabilities)
        || !p.capabilities.includes("read") || !p.capabilities.includes("runs:write")
        || !(p.projectIds === null || Array.isArray(p.projectIds) && p.projectIds.includes(context.projectId))
        || !(p.environmentIds === null || Array.isArray(p.environmentIds) && p.environmentIds.includes(context.environmentId)))
        throw new FiredrillError("SUBMISSION_SCOPE_UNCONFIRMED", "Current identity did not confirm submission/read authority for this scope.", "Select an authorized project/environment and credential with read and runs:write. No target is started.");
    return { id: p.id, organizationId: p.organizationId };
}
function receipt(batch, state, context) {
    const parsed = record(batch) ? RecipeSchema.safeParse(batch.recipe) : undefined;
    const counts = record(batch) && record(batch.counts) ? batch.counts : undefined;
    const names = ["queued", "running", "completed", "error", "interrupted", "cancelled"];
    if (!record(batch) || !identifier(batch.id) || state.batchId !== undefined && state.batchId !== batch.id
        || batch.projectId !== state.projectId || batch.environmentId !== state.environmentId
        || !parsed?.success || canonical(parsed.data) !== canonical(state.recipe)
        || canonical(batch.submission) !== canonical(state.submission)
        || !Number.isSafeInteger(batch.total) || batch.total < 1 || !counts
        || !names.every(name => Number.isSafeInteger(counts[name]) && counts[name] >= 0)
        || names.reduce((sum, name) => sum + counts[name], 0) !== batch.total)
        throw new FiredrillError("SUBMISSION_RECEIPT_UNCONFIRMED", "The service did not confirm the original batch intent and scope.", repair, { uncertain: true, ...(state.batchId ? { batchId: state.batchId } : {}) });
    const kind = parsed.data.target.kind, path = `/v1/batches/${encodeURIComponent(batch.id)}`;
    const confirmed = batch;
    return { schemaVersion: SUBMISSION_RECEIPT_VERSION,
        batch: { id: confirmed.id, projectId: confirmed.projectId, environmentId: confirmed.environmentId,
            name: confirmed.name, createdAt: confirmed.createdAt, cancellationRequested: confirmed.cancellationRequested,
            total: confirmed.total, counts: { queued: confirmed.counts.queued, running: confirmed.counts.running,
                completed: confirmed.counts.completed, error: confirmed.counts.error,
                interrupted: confirmed.counts.interrupted, cancelled: confirmed.counts.cancelled },
            charge: { amount: confirmed.charge.amount, policy: confirmed.charge.policy } },
        submissionKey: state.createKey,
        continuation: { apiUrl: context.apiUrl, projectId: state.projectId, environmentId: state.environmentId,
            batchId: batch.id, identity: { ...state.identity }, targetKind: kind, execution: "customer_runner_required",
            runner: { method: "run", binding: kind === "native" ? "native_callback" : kind === "isolated_node" ? "isolated_node_adapter" : "none",
                cliSupported: kind === "command" || kind === "http" },
            inspection: { batch: `${path}?view=operator`, result: `${path}/result?compact=1`, runs: `${path}/runs` },
            note: "Creation/reconciliation only: this call invoked no target and claims no current queued/idle state. Inspect counts before explicitly attaching a customer runner. Native needs its callback; isolated_node needs its existing TypeScript adapter. A prior runner's uncertain execution must use that runner's real operation ID, not this submission key." } };
}
export async function submitBatch(context, input, options) {
    validateOptions(options, false);
    return coordinate(context, keyValue(options.idempotencyKey), options, recipeValue(input));
}
export async function resumeBatchSubmission(context, key, options = {}) {
    validateOptions(options, true);
    return coordinate(context, keyValue(key), options);
}
async function coordinate(context, key, options, supplied) {
    const selection = { apiUrl: context.apiUrl, projectId: context.projectId, environmentId: context.environmentId };
    let confirmedBatchId;
    try {
        const identity = contextIdentity(await context.request("GET", "/v1/context"), context);
        const digest = createHash("sha256").update(`submission-only\n${key}`).digest("hex");
        const localId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
        const store = new JournalStore(join(context.journalDirectory ?? join(homedir(), ".local", "state", "firedrill", "executions"), "submissions"));
        const unlock = store.lock(localId);
        try {
            let state;
            if (existsSync(join(store.directory, `${localId}.json`))) {
                state = store.read(localId);
                if (state.purpose !== "submission-only" || state.createKey !== key || state.apiUrl !== context.apiUrl
                    || state.projectId !== context.projectId || state.environmentId !== context.environmentId
                    || !state.identity || state.identity.id !== identity.id || state.identity.organizationId !== identity.organizationId
                    || !["create", "done"].includes(state.phase) || !SubmissionMetadataSchema.safeParse(state.submission).success)
                    throw new FiredrillError("SUBMISSION_RECOVERY_CONFLICT", "The saved submission belongs to another scope/identity or is invalid.", "Keep its journal. Use the original API/scope/identity; never overwrite it or substitute an execution journal.");
                state.recipe = recipeValue(state.recipe);
                if (supplied && canonical(supplied) !== canonical(state.recipe))
                    throw new FiredrillError("SUBMISSION_INTENT_CONFLICT", "This key already has a different frozen recipe.", "Use resumeSubmission with its original key to reconcile; deliberately new work requires a new key.");
                matchRetainedSubmission(state.submission, options);
            }
            else {
                if (!supplied)
                    throw new FiredrillError("SUBMISSION_NOT_FOUND", "No private intent exists for this submission key.", "Restore the original private submissions directory. Do not invent a replacement key to recover unknown creation.");
                state = { version: 1, id: localId, ...selection, purpose: "submission-only", identity,
                    recipe: supplied, submission: newSubmission(options), phase: "create", createKey: key,
                    runnerId: "submission-only-not-a-runner", work: [], createdAt: new Date().toISOString() };
                store.save(state); // Exact intent is durable before the first admission request.
            }
            if (state.phase === "done" && !state.batchId || state.batchId !== undefined && !identifier(state.batchId))
                throw new FiredrillError("SUBMISSION_JOURNAL_INVALID", "Saved receipt has no valid batch identity.", repair);
            confirmedBatchId = state.batchId;
            if (!state.batchId) {
                const admitted = receipt(await context.request("POST", "/v1/batches", {
                    projectId: state.projectId, environmentId: state.environmentId, recipe: state.recipe, submission: state.submission,
                }, state.createKey), state, context);
                state.batchId = admitted.batch.id;
                confirmedBatchId = admitted.batch.id;
                state.phase = "done";
                store.save(state);
            }
            // Idempotent admission may replay the creation snapshot. Present only a
            // fresh authorized read; persist its identity first so a read failure can
            // reconcile without another admission or inventing execution work.
            return receipt(await context.request("GET", `/v1/batches/${encodeURIComponent(state.batchId)}`), state, context);
        }
        finally {
            unlock();
        }
    }
    catch (error) {
        throw new SubmissionError(error instanceof FiredrillError ? error : new FiredrillError("SUBMISSION_UNCONFIRMED", "Submission or its local receipt could not be confirmed.", repair, { uncertain: true }), key, selection, confirmedBatchId);
    }
}

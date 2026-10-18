import { RETENTION_VERSION, RemovalPreviewSchema, RemovalCommitSchema } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";
export { RETENTION_VERSION } from "../contracts/index.js";
const previewInput = RemovalPreviewSchema.omit({ schemaVersion: true, projectId: true, environmentId: true });
const commitInput = RemovalCommitSchema.omit({ schemaVersion: true, projectId: true, environmentId: true });
const kinds = new Set(["batch", "run", "scenario", "build", "dataset", "instance", "artifact", "recommendation"]);
function removalId(value) {
    if (typeof value !== "string" || !/^removal_[a-f0-9]{24}$/.test(value))
        throw new FiredrillError("REMOVAL_ID_INVALID", "Select an exact retained removal ID.", "Use the ID from the original removal receipt; never create a replacement merely to inspect progress.");
    return encodeURIComponent(value);
}
function key(value) {
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value))
        throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Removal requires an explicit saved operation key.", "Save the key with the unchanged preview digests, targets and explicit cascade before dispatch. No request was sent.");
    return value;
}
/** Scoped content lifecycle. Deletion requires fresh human-owner authority; CI credentials do not gain it. */
export class FiredrillRetention {
    scope;
    request;
    constructor(scope, request) {
        this.scope = scope;
        this.request = request;
    }
    query(options = {}) {
        if (Object.keys(options).some(name => !["cursor", "limit", "kind", "id"].includes(name)) || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) || options.kind !== undefined && !kinds.has(options.kind) || options.cursor !== undefined && (typeof options.cursor !== "string" || !/^ret_[a-f0-9]{24}$/.test(options.cursor)) || options.id !== undefined && (typeof options.id !== "string" || !/^(ret|batch|run|sbuild|dataset|instance|recommendation)_[a-f0-9]{24}$/.test(options.id)))
            throw new FiredrillError("RETENTION_PAGE_INVALID", "Retention metadata filters are invalid.", "Use limit 1–100, an exact kind/generated opaque ID and the returned cursor unchanged. Authored names/IDs are not metadata lookup keys. No request was sent.");
        return new URLSearchParams({ ...this.scope(), ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])) }).toString();
    }
    policy() { return this.request("GET", `/v1/retention?${this.query()}`); }
    metadata(options = {}) { return this.request("GET", `/v1/retention/metadata?${this.query(options)}`); }
    async preview(input) {
        const selected = previewInput.safeParse(input);
        if (!selected.success)
            throw definitionError("REMOVAL_INPUT_INVALID", "Removal preview targets are invalid.", "Choose exact resource references. Scenario revisions and artifact run IDs must be explicit. No request was sent.", selected.error.issues);
        try {
            return await this.request("POST", "/v1/data-removals/preview", { ...selected.data, schemaVersion: RETENTION_VERSION, ...this.scope() });
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, error.message, "Repeat this read-only preview in the same scope. It does not fence or delete content, allocate work or invoke a target.", { ...error.details, uncertain: false });
            throw error;
        }
    }
    async remove(input, idempotencyKey) {
        const stableKey = key(idempotencyKey);
        // Do not let the schema's wire default turn an omitted cascade into consent.
        if (!input || !Object.hasOwn(input, "cascade") || !Array.isArray(input.cascade))
            throw new FiredrillError("REMOVAL_CASCADE_REQUIRED", "Choose the exact cascade explicitly, including an empty array.", "Review preview.requiredCascade and survivingDefinitions before supplying cascade. No deletion request was sent.");
        const selected = commitInput.safeParse(input);
        if (!selected.success)
            throw definitionError("REMOVAL_INPUT_INVALID", "Removal confirmation is invalid.", "Use the original targets, graphDigest, confirmationDigest and an explicit cascade from the reviewed preview. No request was sent.", selected.error.issues);
        try {
            return await this.request("POST", "/v1/data-removals", { ...selected.data, schemaVersion: RETENTION_VERSION, ...this.scope() }, stableKey);
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, error.message, "Inspect the retained removal if its ID is known. Otherwise explicitly resend only this exact saved key, targets, digests and cascade to reconcile. Do not select a new key or assume deletion completed. There is no automatic retry.", error.details);
            throw error;
        }
    }
    get(id) { return this.request("GET", `/v1/data-removals/${removalId(id)}?${this.query()}`); }
    /** Explicit same-intent cleanup recovery, never a new removal or an automatic retry. */
    async reconcile(id) {
        try {
            return await this.request("POST", `/v1/data-removals/${removalId(id)}/reconcile?${this.query()}`, {});
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, error.message, "Read this same removal ID before another explicit reconciliation. Preserve its original receipt and key; do not start a replacement removal or rerun a target.", error.details);
            throw error;
        }
    }
}

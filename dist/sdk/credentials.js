import { inspect } from "node:util";
import { CreateCredentialSchema, CREDENTIAL_VERSION } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
export class IssuedCredential {
    credential;
    #secret;
    constructor(issue) { this.credential = issue.credential; this.#secret = issue.token; }
    /** Explicit secret export. Never send this value to a model, log, recipe or target. */
    exportSecret() { return this.#secret; }
    toJSON() { return { credential: this.credential, token: "[redacted]" }; }
    [inspect.custom]() { return this.toJSON(); }
}
export class FiredrillCredentials {
    scope;
    request;
    constructor(scope, request) {
        this.scope = scope;
        this.request = request;
    }
    async create(input, idempotencyKey) {
        if (!idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey))
            throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Credential issuance needs an explicit saved operation key.", "Reuse it with the exact same input to recover a lost response.");
        if (!!input.projectId !== !!input.environmentId)
            throw new FiredrillError("SCOPE_REQUIRED", "Select both projectId and environmentId.", "Use an exact scope or the client's selected scope.");
        const scope = input.projectId && input.environmentId ? { projectId: input.projectId, environmentId: input.environmentId } : this.scope();
        const body = CreateCredentialSchema.parse({ ...input, ...scope, schemaVersion: CREDENTIAL_VERSION });
        return new IssuedCredential(await this.request("POST", "/v1/credentials", body, idempotencyKey));
    }
    list(options = {}) {
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
            throw new FiredrillError("PAGE_INVALID", "limit must be between 1 and 100.", "Use the returned cursor unchanged.");
        if (options.cursor !== undefined && !/^cred_[a-f0-9]{24}$/.test(options.cursor))
            throw new FiredrillError("PAGE_INVALID", "The credential cursor is invalid.", "Use the exact returned cursor.");
        const query = new URLSearchParams();
        if (options.cursor)
            query.set("cursor", options.cursor);
        if (options.limit !== undefined)
            query.set("limit", String(options.limit));
        return this.request("GET", `/v1/credentials?${query}`);
    }
    revoke(id) {
        if (!/^cred_[a-f0-9]{24}$/.test(id))
            throw new FiredrillError("CREDENTIAL_ID_INVALID", "Use an exact credential ID.", "Read credential metadata from create or list; never pass its secret here.");
        return this.request("POST", `/v1/credentials/${id}/revoke`, {});
    }
}

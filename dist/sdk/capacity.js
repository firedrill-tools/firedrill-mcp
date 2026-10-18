import { CapacityRequestSchema } from "../contracts/index.js";
import { definitionError, FiredrillError } from "./errors.js";
export class FiredrillCapacity {
    scope;
    send;
    constructor(scope, send) {
        this.scope = scope;
        this.send = send;
    }
    request(input, idempotencyKey) {
        if (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey))
            throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Capacity requests require a saved operation key.", "Reuse the same key and unchanged request after an uncertain response. No request was sent.");
        const parsed = CapacityRequestSchema.safeParse({ ...input, ...this.scope() });
        if (!parsed.success)
            throw definitionError("CAPACITY_REQUEST_INVALID", "The capacity request is invalid.", "Select runs, services, storage or other; describe the request without credentials or simulation data.", parsed.error.issues);
        return this.send("POST", "/v1/capacity-requests", parsed.data, idempotencyKey);
    }
    list(options = {}) {
        if (options.cursor !== undefined && !/^capreq_[a-f0-9]{24}$/.test(options.cursor) || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100))
            throw new FiredrillError("CAPACITY_PAGE_INVALID", "Use the returned capacity cursor and a page size of 1–100.", "Omit the cursor for the first page. No request was sent.");
        return this.send("GET", `/v1/capacity-requests?${new URLSearchParams({ ...this.scope(), ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.limit !== undefined ? { limit: String(options.limit) } : {}) })}`);
    }
}

import { CapacityRequestSchema, type CapacityRequest, type CapacityRequestInput, type CapacityRequestPage, type Scope } from "../contracts/index.js";
import { definitionError, FiredrillError } from "./errors.js";

export type CapacityRequestOptions = Omit<CapacityRequestInput, "projectId" | "environmentId">;
export type { CapacityRequest, CapacityRequestPage, CapacityResource } from "../contracts/index.js";
type Request = <T>(method: string, path: string, body?: unknown, key?: string) => Promise<T>;

export class FiredrillCapacity {
  constructor(private readonly scope: () => Scope, private readonly send: Request) {}
  request(input: CapacityRequestOptions, idempotencyKey: string): Promise<CapacityRequest> {
    if (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey))
      throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Capacity requests require a saved operation key.", "Reuse the same key and unchanged request after an uncertain response. No request was sent.");
    const parsed = CapacityRequestSchema.safeParse({ ...input, ...this.scope() });
    if (!parsed.success) throw definitionError("CAPACITY_REQUEST_INVALID", "The capacity request is invalid.", "Select runs, services, storage or other; describe the request without credentials or simulation data.", parsed.error.issues);
    return this.send("POST", "/v1/capacity-requests", parsed.data, idempotencyKey);
  }
  list(options: { cursor?: string; limit?: number } = {}): Promise<CapacityRequestPage> {
    if (options.cursor !== undefined && !/^capreq_[a-f0-9]{24}$/.test(options.cursor) || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100))
      throw new FiredrillError("CAPACITY_PAGE_INVALID", "Use the returned capacity cursor and a page size of 1–100.", "Omit the cursor for the first page. No request was sent.");
    return this.send("GET", `/v1/capacity-requests?${new URLSearchParams({ ...this.scope(), ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.limit !== undefined ? { limit: String(options.limit) } : {}) })}`);
  }
}

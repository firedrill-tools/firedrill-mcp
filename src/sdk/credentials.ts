import { inspect } from "node:util";
import { CreateCredentialSchema, CREDENTIAL_VERSION, type CredentialIssue, type CredentialMetadata, type CredentialPage, type MachineCapability } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
export type { CredentialMetadata, CredentialPage, MachineCapability } from "../contracts/index.js";
export interface IssueCredentialInput {
  label: string; capabilities: MachineCapability[]; expiresInSeconds?: number;
  projectId?: string; environmentId?: string;
}
type Request = <T>(method: string, path: string, body?: unknown, key?: string) => Promise<T>;
export class IssuedCredential {
  readonly credential: CredentialMetadata;
  readonly #secret: string;
  constructor(issue: CredentialIssue) { this.credential = issue.credential; this.#secret = issue.token; }
  /** Explicit secret export. Never send this value to a model, log, recipe or target. */
  exportSecret(): string { return this.#secret; }
  toJSON() { return { credential: this.credential, token: "[redacted]" }; }
  [inspect.custom]() { return this.toJSON(); }
}
export class FiredrillCredentials {
  constructor(private readonly scope: () => { projectId: string; environmentId: string }, private readonly request: Request) {}
  async create(input: IssueCredentialInput, idempotencyKey: string): Promise<IssuedCredential> {
    if (!idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Credential issuance needs an explicit saved operation key.", "Reuse it with the exact same input to recover a lost response.");
    if (!!input.projectId !== !!input.environmentId) throw new FiredrillError("SCOPE_REQUIRED", "Select both projectId and environmentId.", "Use an exact scope or the client's selected scope.");
    const scope = input.projectId && input.environmentId ? { projectId: input.projectId, environmentId: input.environmentId } : this.scope();
    const body = CreateCredentialSchema.parse({ ...input, ...scope, schemaVersion: CREDENTIAL_VERSION });
    return new IssuedCredential(await this.request<CredentialIssue>("POST", "/v1/credentials", body, idempotencyKey));
  }
  list(options: { cursor?: string; limit?: number } = {}): Promise<CredentialPage> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new FiredrillError("PAGE_INVALID", "limit must be between 1 and 100.", "Use the returned cursor unchanged.");
    if (options.cursor !== undefined && !/^cred_[a-f0-9]{24}$/.test(options.cursor)) throw new FiredrillError("PAGE_INVALID", "The credential cursor is invalid.", "Use the exact returned cursor.");
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.request("GET", `/v1/credentials?${query}`);
  }
  revoke(id: string): Promise<CredentialMetadata> {
    if (!/^cred_[a-f0-9]{24}$/.test(id)) throw new FiredrillError("CREDENTIAL_ID_INVALID", "Use an exact credential ID.", "Read credential metadata from create or list; never pass its secret here.");
    return this.request("POST", `/v1/credentials/${id}/revoke`, {});
  }
}

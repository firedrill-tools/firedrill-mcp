import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { JsonSchema, DatasetPolicySchema, DatasetMetadataSchema, type DatasetPolicy, type DatasetMetadata, type DatasetValidationReceipt, type Json, type Scope, type ServiceCatalogPage, type ServiceCatalogRelease, type AcquireServiceCatalogInput, type ServiceCatalogAcquisition } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";
import { startTools, resumeTools, type ToolStartPlan, type ToolStartOptions, type ToolStartContext } from "./tool-start.js";
import type { ServiceBuildFailure } from "./service-build-diagnostics.js";

export type ServiceManifest = Record<string, Json>;
export interface ServicePolicy {
  limits: { defaultTtlSeconds: number; maxTtlSeconds: number; maxActiveInstances: number };
  /** Absent on older services; absence is not an unbounded-resource promise. */
  resourceEnvelope?: import("../contracts/index.js").ServiceResourceEnvelope;
}
export interface ServiceSource { path: string; content: string }
export interface ServiceView {
  schemaVersion: 1; title: string;
  records?: { id: string; title: string; operationId: string; arguments: Record<string, Json>; rowsPath: string[]; columns: { label: string; path: string[] }[] }[];
  forms?: { id: string; title: string; operationId: string; fields: { name: string; label: string; kind: "text" | "integer" | "number" | "boolean" }[] }[];
}
export interface PublishServiceInput { manifest: ServiceManifest; entryPoint: string; files: ServiceSource[]; view?: ServiceView; conformance?: ServiceConformanceInput; datasetPolicy?: DatasetPolicy }
export interface PublishDirectoryInput { directory: string; manifestPath: string; entryPoint: string; files: string[]; viewPath?: string; conformance?: ServiceConformanceInput; datasetPolicy?: DatasetPolicy }
export interface ServiceBuild { id: string; projectId: string; status: string; manifest: ServiceManifest; sourceDigest: string; manifestDigest: string; artifactDigest: string | null; view?: ServiceView | null; viewDigest?: string | null; datasetPolicy?: DatasetPolicy | null; datasetPolicyDigest?: string | null; publicationDigest?: string | null; failure?: ServiceBuildFailure | null; createdAt: string }
export interface ServiceSeedRecord { namespace: string; rowId: string; value: Record<string, Json> }
export interface SeedServiceInput { buildId: string; records: ServiceSeedRecord[]; initialVirtualTimeUs?: number; metadata?: DatasetMetadata }
export interface ServiceDataset { schemaVersion?: "2026-10-15-dataset.1"; id: string; projectId: string; buildId: string; version: string; records: number; initialVirtualTimeUs?: number; metadata?: DatasetMetadata | null; validation?: DatasetValidationReceipt | null; validationStatus?: "validated" | "not_recorded"; createdAt: string }
export interface ServiceBuildEntry extends Omit<ServiceBuild, "manifest" | "view" | "viewDigest" | "datasetPolicy" | "publicationDigest"> { datasetConstraintCount?: number | null; metadataOnly?: boolean; service?: { id: string; version: string; operationCount: number; viewDeclared: boolean } }
export interface ServiceDatasetEntry extends ServiceDataset { metadataOnly?: boolean }
export interface ServiceDatasetDetail extends ServiceDataset { recordPage?: ServicePage<ServiceSeedRecord> }
export type ServiceInstanceStatus = "creating" | "active" | "paused" | "recovery_required" | "expired" | "destroyed";
export interface ServiceInstanceListOptions { order?: "newest"; lifecycle?: "active" | "history" | "all"; q?:string; status?:ServiceInstanceStatus; cursor?: string; limit?: number }
export interface ServiceInstancePage { items: ServiceInstance[]; nextCursor: string | null; order?: "newest"; lifecycle?: "active" | "history" | "all" }
export interface CreateServiceInput { buildId: string; datasetId?: string; seed: string; actorOperations: string[]; ttlSeconds?: number }
export interface ServiceInstance {
  id: string; projectId: string; environmentId: string; buildId: string; datasetId: string | null;
  epoch: number; status: string; createdAt: string; expiresAt: string; finishedAt: string | null;
  seed: string; actorOperations: string[]; runtime: Json | null; invocationPolicy: "creating_credential_only" | "creating_member_or_credential_only" | "current_run_connection_only";
  service?: { id: string; version: string; name: null; httpRoutes: { method: string; path: string; operationId: string }[]; view: { declared: boolean; available: boolean; title: string | null; operationIds: string[]; readOnly?: boolean } };
}
export interface ServiceActionResult<T extends Json = Json> { operationId: string; instance: ServiceInstance; result: T }
export interface ServiceHistoryEvent { sequence: number; operationId: string | null; operationState: string | null; kind: string; payload: Json; recordedAt: string }
export interface ServicePage<T> { items: T[]; nextCursor: number | null }
export interface ServicePageOptions { cursor?: number; limit?: number }
export interface ServiceBuildListOptions extends ServicePageOptions { q?:string; status?:"building"|"ready"|"failed" }
export interface ServiceHistoryOptions extends ServicePageOptions { q?:string; kind?:string }
export interface ServiceObservationOptions extends ServicePageOptions { epoch?: number; evidenceCursor?: number; namespace?:string; rowQ?:string; activityKind?:string; activityQ?:string; pendingQ?:string }
export interface ServiceObservedPage<T> { items: T[]; total?: number; complete: boolean; nextCursor: number | null; digest: string }
export interface ServiceObservation {
  schemaVersion: "2026-10-15-service-observation.1"; instanceId: string; epoch: number; observedAt: string;
  provenance: "service_attested"; virtualTimeUs: number; evidenceHead: number; lifecycle: string;
  namespaces?:string[]; state: ServiceObservedPage<ServiceSeedRecord>; pendingWork: ServiceObservedPage<Json>; activity: ServiceObservedPage<Json>; digest: string;
}
export type ServicePendingWork = Pick<ServiceObservation, "schemaVersion" | "instanceId" | "epoch" | "observedAt" | "virtualTimeUs" | "provenance"> & ServiceObservedPage<Json>;
export interface ServiceConformanceInput {
  schemaVersion: 1;
  cases: { id: string; seed?: string; actorOperations: string[]; records?: ServiceSeedRecord[];
    steps: { operationId: string; arguments: Record<string, Json>; expect: { path: string; expected: Json }[] }[] }[];
}
export interface ServiceConformance {
  id: string; buildId: string; buildStatusUnchanged?: true; createdAt?: string;
  receipt: { schemaVersion: "2026-10-15-service-conformance.1"; fixtureDigest: string; artifactDigest: string; manifestDigest: string;
    operationDispatch: boolean; executedSteps: number; isolation: "fresh_restricted_instance_per_case"; state: "satisfied" | "violated";
    cases: { id: string; state: "satisfied" | "violated" | "error"; steps: Json[]; evidenceDigest: string | null }[];
    scope: "supplied_cases_only_not_universal_fidelity"; digest: string };
}
export interface ServiceEpoch { epoch: number }
export interface ServiceInvokeInput extends ServiceEpoch { operationId: string; arguments: Record<string, Json>; operationKey?: string }
export interface ServiceResetInput extends ServiceEpoch { snapshotId: string }
export interface ServiceClockInput extends ServiceEpoch { toUs: number; maxEvents?: number }
export interface ServiceExtendInput extends ServiceEpoch { expectedExpiresAt: string; expiresAt: string }
export type ServiceExtendResult = ServiceActionResult<{ previousExpiresAt: string; expiresAt: string; computeResumed: false; connectionsRenewed: false }>;
export interface CreateConnectionInput extends ServiceEpoch {
  audience: "http" | "mcp" | "ui"; purpose: "manual" | "target"; allowedOperations: string[]; ttlSeconds: number;
}
export interface ServiceConnection {
  id: string; organizationId: string; projectId: string; environmentId: string; instanceId: string; epoch: number;
  audience: "http" | "mcp" | "ui"; purpose: "manual" | "target"; purposeEvidence: "declared_intent_not_execution_attestation";
  allowedOperations: string[]; createdAt: string; expiresAt: string; revokedAt: string | null; uiOrigin?: string | null; observationOnly?: boolean;
}
interface ConnectionGrantWire { connection: ServiceConnection; token: string | null; launchUrl?: string | null; tokenDelivery: "one_time" | "not_repeated"; repair: string }
/** One-time credential: ordinary JSON and object inspection deliberately omit it. */
export class ConnectionGrant {
  readonly connection: ServiceConnection;
  readonly tokenDelivery: ConnectionGrantWire["tokenDelivery"];
  readonly repair: string;
  readonly #token: string | null;
  readonly #launchUrl: string | null;
  constructor(value: ConnectionGrantWire) { this.connection = value.connection; this.tokenDelivery = value.tokenDelivery; this.repair = value.repair; this.#token = value.token; this.#launchUrl = value.launchUrl ?? null; }
  revealToken(): string | null { return this.#token; }
  revealLaunchUrl(): string | null { return this.#launchUrl; }
  toJSON() { return { connection: this.connection, tokenDelivery: this.tokenDelivery, repair: this.repair }; }
}
type Request = <T>(method: string, path: string, body?: unknown, key?: string) => Promise<T>;
function fail(code: string, message: string, repair: string): never { throw new FiredrillError(code, message, repair); }
function key(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n]/.test(value)) fail("IDEMPOTENCY_REQUIRED", "This mutation needs an explicit stable key of 1–200 characters.", "Save and reuse the same key with identical input after an uncertain response. Choose a new key only for a new action.");
  return value;
}
function integer(value: number, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("SERVICE_ARGUMENT_INVALID", `${name} must be an integer between ${minimum} and ${maximum}.`, "Read the retained instance and supply exact epoch/time/page values.");
  return value;
}
function readFilters(values:Record<string,unknown>):string {
  const query=new URLSearchParams();
  for(const [name,input] of Object.entries(values)) {
    if(input===undefined) continue;
    const maximum=name==="namespace"?96:name==="kind"||name==="activityKind"?80:120;
    if(typeof input!=="string" || input.length>maximum || /[\x00-\x1f\x7f]/.test(input) || (name==="kind"||name==="activityKind")&&!/^[a-zA-Z0-9_.:-]+$/.test(input)) fail("SERVICE_FILTER_INVALID",`${name} must be a bounded text filter.`,"Clear the page cursor when changing search or filters; retain the exact instance epoch while paging observation.");
    const value=["q","rowQ","activityQ","pendingQ"].includes(name)?input.trim():input;
    if(value) query.set(name,value);
  }
  return query.size?`&${query}`:"";
}
function readStatus(value:unknown,allowed:readonly string[]):void {
  if(value!==undefined && (typeof value!=="string"||!allowed.includes(value))) fail("SERVICE_FILTER_INVALID","Choose a declared Tool status.",`Use ${allowed.join(", ")}; clear cursor when changing status.`);
}
function absoluteExpiry(value: string, name: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail("SERVICE_ARGUMENT_INVALID", `${name} must be a canonical UTC timestamp including milliseconds.`, "Read the instance expiry and save exact expectedExpiresAt/expiresAt values, for example 2026-10-15T12:00:00.000Z. Reuse them unchanged with the same key after an uncertain response.");
}
function id(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) fail("SERVICE_ID_INVALID", "Select an exact retained service resource ID.", "Use the ID returned by publication, creation or tools list.");
  return encodeURIComponent(value);
}
function catalogId(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail("SERVICE_CATALOG_ID_INVALID", "Select an exact catalog ID.", "Read services.catalog() and use a returned ID; no service source is installed locally.");
  return value;
}
function object(value: unknown, name: string): asserts value is Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !JsonSchema.safeParse(value).success) fail("SERVICE_INPUT_INVALID", `${name} must be a JSON object.`, "Supply explicit JSON input; no dataset, operations or example is inferred.");
}
function sourcePath(value: string): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:ts|js|mjs)$/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")))
    fail("SERVICE_SOURCE_PATH_INVALID", "Selected source paths must be visible relative .ts, .js or .mjs files without traversal.", "List only the service source files you intend to publish; do not select secrets, symlinks or dependency folders.");
  return value;
}
function readSelected(directory: string, relative: string, maximum: number): string {
  if (!relative || isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")))
    fail("SERVICE_SOURCE_PATH_INVALID", "Selected files must remain visibly inside the chosen directory.", "Use an explicit relative file path without traversal, hidden segments or symlinks.");
  let path = resolve(directory);
  for (const segment of ["", ...relative.split("/")]) {
    path = segment ? join(path, segment) : path;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail("SERVICE_SOURCE_SYMLINK", "A selected source path includes a symbolic link.", "Select actual files in the source directory; symlink traversal is not published.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) fail("SERVICE_SOURCE_LIMIT", "Selected input is not a bounded regular file.", `Use a regular file of at most ${maximum} bytes; hard links are not published.`);
    const data = readFileSync(fd);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { return fail("SERVICE_SOURCE_ENCODING", "Selected source must be UTF-8 text.", "Convert the selected file explicitly; binary data is not service source."); }
  } finally { closeSync(fd); }
}

/** Authenticated transport convenience only. All compilation, state and authority remain service-side. */
export class FiredrillServices {
  constructor(private readonly scope: () => Scope, private readonly request: Request, private readonly context?: ToolStartContext) {}
  /** Optional manual Tools. Simulations allocate their own case-scoped services. */
  start(plan: ToolStartPlan, options: ToolStartOptions = {}) { return startTools(this, this.scope(), this.context, plan, options); }
  resumeStart(operationKey: string, options: Omit<ToolStartOptions, "operationKey"> = {}) { return resumeTools(this, this.scope(), this.context, operationKey, options); }
  private query(page: ServicePageOptions = {}): string {
    const query = new URLSearchParams(this.scope());
    if (page.cursor !== undefined) query.set("cursor", String(integer(page.cursor, "cursor")));
    if (page.limit !== undefined) query.set("limit", String(integer(page.limit, "limit", 1, 100)));
    return `?${query}`;
  }
  private async mutation<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    key(idempotencyKey);
    if (Buffer.byteLength(JSON.stringify(body)) > 9 * 1024 * 1024) fail("SERVICE_REQUEST_LIMIT", "Service request exceeds the bounded JSON transport size.", "Select less source or fewer seed records; no request was sent.");
    try { return await this.request<T>("POST", path, body, idempotencyKey); }
    catch (error) {
      if (error instanceof FiredrillError && error.details.uncertain) throw new FiredrillError(error.code, "The service action acknowledgement could not be confirmed.", "Inspect tools get/history. Reuse the exact saved key and unchanged input to reconcile; never advance the epoch or start another action merely because a response was lost.", error.details);
      throw error;
    }
  }
  catalog(): Promise<ServiceCatalogPage> { return this.request("GET", `/v1/service-catalog${this.query()}`); }
  policy(): Promise<ServicePolicy> { return this.request("GET", `/v1/service-policy${this.query()}`); }
  /** Filters apply before pagination. Restart without cursor when filters change. */
  builds(options: ServiceBuildListOptions = {}): Promise<ServicePage<ServiceBuildEntry>> { readStatus(options.status,["building","ready","failed"]); return this.request("GET", `/v1/service-builds${this.query(options)}${readFilters({q:options.q,status:options.status})}`); }
  build(buildId: string): Promise<ServiceBuild> { return this.request("GET", `/v1/service-builds/${id(buildId)}${this.query()}`); }
  datasets(options: ServicePageOptions & { buildId?: string; q?:string } = {}): Promise<ServicePage<ServiceDatasetEntry>> {
    return this.request("GET", `/v1/service-datasets${this.query(options)}${options.buildId ? `&buildId=${id(options.buildId)}` : ""}${readFilters({q:options.q})}`);
  }
  dataset(datasetId: string, options: ServicePageOptions & { includeRecords?: boolean } = {}): Promise<ServiceDatasetDetail> {
    if (options.includeRecords !== undefined && typeof options.includeRecords !== "boolean") fail("SERVICE_ARGUMENT_INVALID", "includeRecords must be a boolean.", "Omit it for metadata, or explicitly request a bounded records page.");
    return this.request("GET", `/v1/service-datasets/${id(datasetId)}${this.query(options)}${options.includeRecords ? "&includeRecords=true" : ""}`);
  }
  catalogRelease(selectedId: string): Promise<ServiceCatalogRelease> {
    return this.request("GET", `/v1/service-catalog/${catalogId(selectedId)}${this.query()}`);
  }
  async acquire(input: Omit<AcquireServiceCatalogInput, keyof Scope>, idempotencyKey: string): Promise<ServiceCatalogAcquisition> {
    key(idempotencyKey);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(name => !["catalogId", "releaseDigest", "initialData"].includes(name)))
      fail("SERVICE_CATALOG_INPUT_INVALID", "Acquisition accepts only catalogId, releaseDigest and initialData.", "Scope comes from this selected client; do not pass another project or environment in the selection.");
    catalogId(input.catalogId);
    if (typeof input.releaseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.releaseDigest) || !["empty", "starter"].includes(input.initialData))
      fail("SERVICE_CATALOG_INPUT_INVALID", "Pin the exact catalog release digest and explicitly choose empty or starter data.", "Read services.catalogRelease(id), save its releaseDigest and your intended data choice, then reuse that exact input/key after an uncertain reply.");
    try {
      return await this.mutation("/v1/service-catalog/acquisitions", { ...this.scope(), catalogId: input.catalogId, releaseDigest: input.releaseDigest, initialData: input.initialData }, idempotencyKey);
    } catch (error) {
      if (error instanceof FiredrillError && error.details.uncertain) throw new FiredrillError(error.code, "Catalog acquisition acknowledgement could not be confirmed.", "Read services.acquisitionByKey(originalKey) in this same scope. Keep the exact catalog ID, release digest, data choice and key; never allocate a replacement to recover a lost reply.", error.details);
      throw error;
    }
  }
  acquisition(acquisitionId: string): Promise<ServiceCatalogAcquisition> {
    return this.request("GET", `/v1/service-catalog/acquisitions/${id(acquisitionId)}${this.query()}`);
  }
  acquisitionByKey(originalKey: string): Promise<ServiceCatalogAcquisition> {
    key(originalKey);
    return this.request("GET", `/v1/service-catalog/acquisitions/by-key${this.query()}&key=${encodeURIComponent(originalKey)}`);
  }
  publish(input: PublishServiceInput, idempotencyKey: string): Promise<ServiceBuild> {
    key(idempotencyKey); object(input.manifest, "manifest"); sourcePath(input.entryPoint);
    if (input.datasetPolicy !== undefined) {
      const parsed = DatasetPolicySchema.safeParse(input.datasetPolicy);
      if (!parsed.success) throw definitionError("SERVICE_DATASET_POLICY_INVALID", "Dataset policy is invalid.", "Use explicit unique/reference/count constraints from the advertised dataset-policy schema; no publication was sent.", parsed.error.issues);
    }
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 128) fail("SERVICE_FILES_REQUIRED", "Select one to 128 source files explicitly.", "Pass files or use interactive source selection; whole-directory upload is never implicit.");
    const names = new Set<string>(); let bytes = 0;
    for (const file of input.files) {
      sourcePath(file.path);
      if (names.has(file.path.toLowerCase())) fail("SERVICE_FILES_CONFLICT", "Selected source paths are not case-insensitively unique.", "Select each source path exactly once.");
      names.add(file.path.toLowerCase());
      if (typeof file.content !== "string" || Buffer.byteLength(file.content) > 1024 * 1024) fail("SERVICE_SOURCE_LIMIT", "Each selected source file must be UTF-8 text of at most 1 MiB.", "Reduce the selected source; no publication was sent.");
      bytes += Buffer.byteLength(file.content);
    }
    if (!input.files.some(file => file.path === input.entryPoint) || bytes > 4 * 1024 * 1024) fail("SERVICE_SOURCE_LIMIT", "Entrypoint must be selected and total source must not exceed this client's 4 MiB bound.", "Select the entrypoint and reduce source if needed. This per-request engineering safeguard applies before upload.");
    return this.mutation("/v1/service-builds", { ...input, ...this.scope() }, idempotencyKey);
  }
  publishDirectory(input: PublishDirectoryInput, idempotencyKey: string): Promise<ServiceBuild> {
    key(idempotencyKey);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 128) fail("SERVICE_FILES_REQUIRED", "Explicit selected source files are required.", "Supply the exact files; the SDK never uploads an entire directory by default.");
    let manifest: unknown;
    try { manifest = JSON.parse(readSelected(input.directory, input.manifestPath, 1024 * 1024)); }
    catch (error) { if (error instanceof FiredrillError) throw error; return fail("SERVICE_MANIFEST_INVALID", "Selected manifest is missing or invalid JSON.", "Use a visible regular JSON manifest inside the selected directory."); }
    object(manifest, "manifest");
    let view: ServiceView | undefined;
    if (input.viewPath !== undefined) {
      try { view = JSON.parse(readSelected(input.directory, input.viewPath, 65536)); object(view, "view"); }
      catch (error) { if (error instanceof FiredrillError) throw error; return fail("SERVICE_VIEW_INVALID", "Selected view declaration is missing or invalid JSON.", "Use a bounded visible JSON file containing the data-only service view declaration."); }
    }
    return this.publish({ manifest, ...(view ? { view } : {}), ...(input.conformance ? { conformance: input.conformance } : {}), ...(input.datasetPolicy !== undefined ? { datasetPolicy: input.datasetPolicy } : {}), entryPoint: input.entryPoint, files: input.files.map(path => ({ path: sourcePath(path), content: readSelected(input.directory, path, 1024 * 1024) })) }, idempotencyKey);
  }
  seed(input: SeedServiceInput, idempotencyKey: string): Promise<ServiceDataset> {
    id(input.buildId);
    if (!Array.isArray(input.records) || input.records.length > 100000) fail("SERVICE_DATASET_INVALID", "Seed records must be an explicit array of at most 100,000 records.", "Use [] for an intentionally empty dataset; no sample data is inferred.");
    for (const record of input.records) object(record.value, "record.value");
    if (input.initialVirtualTimeUs !== undefined) integer(input.initialVirtualTimeUs, "initialVirtualTimeUs");
    if (input.metadata !== undefined) {
      const parsed = DatasetMetadataSchema.safeParse(input.metadata);
      if (!parsed.success) throw definitionError("SERVICE_DATASET_METADATA_INVALID", "Dataset metadata is invalid.", "Declare provenance and exact dataset-version mappings explicitly; no dataset was saved.", parsed.error.issues);
    }
    return this.mutation("/v1/service-datasets", { ...input, ...this.scope() }, idempotencyKey);
  }
  create(input: CreateServiceInput, idempotencyKey: string): Promise<ServiceInstance> {
    id(input.buildId); if (input.datasetId) id(input.datasetId);
    if (typeof input.seed !== "string" || !/^(0|[1-9][0-9]*)$/.test(input.seed)) fail("SERVICE_SEED_REQUIRED", "Supply an explicit unsigned decimal seed string.", "Choose and retain the seed for this instance; no seed is inferred.");
    if (!Array.isArray(input.actorOperations) || !input.actorOperations.length || new Set(input.actorOperations).size !== input.actorOperations.length) fail("SERVICE_GRANT_REQUIRED", "Choose distinct allowed operation IDs explicitly.", "Use the selected build's declared operations. Invocation is currently bound to the creating credential.");
    if (input.ttlSeconds !== undefined) integer(input.ttlSeconds, "ttlSeconds", 1);
    return this.mutation("/v1/service-instances", { ...input, ...this.scope() }, idempotencyKey);
  }
  get(instanceId: string): Promise<ServiceInstance> { return this.request("GET", `/v1/service-instances/${id(instanceId)}${this.query()}`); }
  list(options: ServicePageOptions = {}): Promise<ServicePage<ServiceInstance>> { return this.request("GET", `/v1/service-instances${this.query(options)}`); }
  instances(options: ServiceInstanceListOptions = {}): Promise<ServiceInstancePage> {
    const query = new URLSearchParams(this.scope()); query.set("order", "newest");
    const lifecycle = options.lifecycle ?? "active";
    if (!["active", "history", "all"].includes(lifecycle)) fail("SERVICE_ARGUMENT_INVALID", "Choose active, history or all instances.", "Clear cursor when changing filters.");
    query.set("lifecycle", lifecycle);
    if (options.cursor !== undefined) { if (typeof options.cursor !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(options.cursor)) fail("SERVICE_ARGUMENT_INVALID", "Newest instance pages use their returned opaque cursor.", "Omit cursor on the first page; copy nextCursor unchanged and clear it when changing filters."); query.set("cursor", options.cursor); }
    query.set("limit", String(integer(options.limit ?? 25, "limit", 1, 100)));
    readStatus(options.status,["creating","active","paused","recovery_required","expired","destroyed"]);
    return this.request("GET", `/v1/service-instances?${query}${readFilters({q:options.q,status:options.status})}`);
  }
  history(instanceId: string, options: ServiceHistoryOptions = {}): Promise<ServicePage<ServiceHistoryEvent>> { return this.request("GET", `/v1/service-instances/${id(instanceId)}/history${this.query(options)}${readFilters({q:options.q,kind:options.kind})}`); }
  private observationQuery(options: ServiceObservationOptions): string {
    let value = this.query(options);
    if (options.epoch !== undefined) value += `&epoch=${integer(options.epoch, "epoch")}`;
    if (options.evidenceCursor !== undefined) value += `&evidenceCursor=${integer(options.evidenceCursor, "evidenceCursor")}`;
    return value+readFilters({namespace:options.namespace,rowQ:options.rowQ,activityKind:options.activityKind,activityQ:options.activityQ,pendingQ:options.pendingQ});
  }
  /** Canonical state/activity, not target-reported. Retain epoch; clear cursors when changing filters. */
  observe(instanceId: string, options: ServiceObservationOptions = {}): Promise<ServiceObservation> {
    return this.request("GET", `/v1/service-instances/${id(instanceId)}/observation${this.observationQuery(options)}`);
  }
  pending(instanceId: string, options: ServiceObservationOptions = {}): Promise<ServicePendingWork> {
    return this.request("GET", `/v1/service-instances/${id(instanceId)}/pending${this.observationQuery(options)}`);
  }
  conform(buildId: string, input: ServiceConformanceInput, idempotencyKey: string): Promise<ServiceConformance> {
    object(input, "conformance");
    if (input.schemaVersion !== 1 || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 20 || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
      fail("SERVICE_CONFORMANCE_INVALID", "Conformance requires schemaVersion 1 and one to twenty explicit cases within 1 MiB.", "Supply independent seed/grant/operation/expectation fixtures; the service validates and executes only these supplied cases.");
    return this.mutation(`/v1/service-builds/${id(buildId)}/conformance${this.query()}`, input, idempotencyKey);
  }
  conformance(receiptId: string): Promise<ServiceConformance> { return this.request("GET", `/v1/service-conformance/${id(receiptId)}${this.query()}`); }
  /** Read-only UI for an active owned run. Never a target invocation grant. */
  async createObservationConnection(instanceId: string, input: ServiceEpoch & { ttlSeconds?: number }, idempotencyKey: string): Promise<ConnectionGrant> {
    integer(input.epoch, "epoch"); if (input.ttlSeconds !== undefined) integer(input.ttlSeconds, "ttlSeconds", 1, 604800);
    try { return new ConnectionGrant(await this.mutation(`/v1/service-instances/${id(instanceId)}/observation-connection${this.query()}`, input, idempotencyKey)); }
    catch (error) {
      if (error instanceof FiredrillError && error.details.uncertain) throw new FiredrillError(error.code, "Observation grant acknowledgement could not be confirmed.", "Reconcile the same key/input, inspect connection metadata, then revoke a lost grant before deliberately creating a replacement. No target credential is substituted.", error.details);
      throw error;
    }
  }
  async createConnection(instanceId: string, input: CreateConnectionInput, idempotencyKey: string): Promise<ConnectionGrant> {
    integer(input.epoch, "epoch"); integer(input.ttlSeconds, "ttlSeconds", 1, 604800);
    if (!["http", "mcp", "ui"].includes(input.audience) || !["manual", "target"].includes(input.purpose) || !Array.isArray(input.allowedOperations) || !input.allowedOperations.length || input.allowedOperations.length > 256 || new Set(input.allowedOperations).size !== input.allowedOperations.length || input.allowedOperations.some(value => typeof value !== "string" || !value || value.length > 160))
      fail("CONNECTION_INPUT_INVALID", "Choose an MCP or UI audience, declared purpose and distinct operation IDs explicitly.", "Use only the selected instance's permitted operations. Purpose is intent, not proof of target execution.");
    try { return new ConnectionGrant(await this.mutation(`/v1/service-instances/${id(instanceId)}/connections${this.query()}`, input, idempotencyKey)); }
    catch (error) {
      if (error instanceof FiredrillError && error.details.uncertain) throw new FiredrillError(error.code, "The one-time connection credential response was not confirmed.", "Reconcile metadata with the same key and input. The secret is not repeated: explicitly revoke that grant, then create a new grant with a new saved key if the original secret was lost.", error.details);
      throw error;
    }
  }
  connections(instanceId: string, options: ServicePageOptions = {}): Promise<ServicePage<ServiceConnection>> { return this.request("GET", `/v1/service-instances/${id(instanceId)}/connections${this.query(options)}`); }
  revokeConnection(instanceId: string, connectionId: string, idempotencyKey: string): Promise<{ connection: ServiceConnection }> {
    return this.mutation(`/v1/service-instances/${id(instanceId)}/connections/${id(connectionId)}/revoke${this.query()}`, {}, idempotencyKey);
  }
  private action<T extends Json = Json>(instanceId: string, action: string, input: ServiceEpoch, idempotencyKey: string): Promise<ServiceActionResult<T>> {
    integer(input.epoch, "epoch"); return this.mutation(`/v1/service-instances/${id(instanceId)}/${action}${this.query()}`, input, idempotencyKey);
  }
  invoke(instanceId: string, input: ServiceInvokeInput, idempotencyKey: string): Promise<ServiceActionResult> {
    object(input.arguments, "arguments"); return this.action(instanceId, "invoke", input, idempotencyKey);
  }
  snapshot(instanceId: string, input: ServiceEpoch, idempotencyKey: string): Promise<ServiceActionResult> { return this.action(instanceId, "snapshot", input, idempotencyKey); }
  reset(instanceId: string, input: ServiceResetInput, idempotencyKey: string): Promise<ServiceActionResult> { return this.action(instanceId, "reset", input, idempotencyKey); }
  /** Restore modeled snapshot state and clock; never reset the customer's agent or application. */
  rewind(instanceId: string, input: ServiceResetInput, idempotencyKey: string): Promise<ServiceActionResult> { return this.action(instanceId, "rewind", input, idempotencyKey); }
  clock(instanceId: string, input: ServiceClockInput, idempotencyKey: string): Promise<ServiceActionResult> {
    integer(input.toUs, "toUs"); if (input.maxEvents !== undefined) integer(input.maxEvents, "maxEvents", 1, 1000);
    return this.action(instanceId, "clock", input, idempotencyKey);
  }
  pause(instanceId: string, input: ServiceEpoch, idempotencyKey: string): Promise<ServiceActionResult> { return this.action(instanceId, "pause", input, idempotencyKey); }
  resume(instanceId: string, input: ServiceEpoch, idempotencyKey: string): Promise<ServiceActionResult> { return this.action(instanceId, "resume", input, idempotencyKey); }
  /** Extend only a manual Tool's lifetime; never resume compute or renew connection grants. */
  extend(instanceId: string, input: ServiceExtendInput, idempotencyKey: string): Promise<ServiceExtendResult> {
    absoluteExpiry(input.expectedExpiresAt, "expectedExpiresAt"); absoluteExpiry(input.expiresAt, "expiresAt");
    return this.action(instanceId, "extend", input, idempotencyKey);
  }
  destroy(instanceId: string, input: ServiceEpoch, idempotencyKey: string): Promise<ServiceActionResult> { return this.action(instanceId, "destroy", input, idempotencyKey); }
}

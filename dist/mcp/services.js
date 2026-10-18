import { createHash } from "node:crypto";
import { z } from "zod";
import { DatasetPolicySchema, DatasetMetadataSchema, JsonSchema, ScopeSchema } from "../contracts/index.js";
import { FiredrillError, FiredrillServices, executeToolStart, validateToolStartPlan, readServiceBuildFailure } from "../sdk/index.js";
// Transport declarations only. The service validates the authoritative manifest,
// source capabilities, state schemas and lifecycle; no private engine is imported.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const catalogId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const releaseDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const operationId = z.string().min(1).max(160);
const key = z.string().min(1).max(200).regex(/^[^\r\n]+$/).describe("Persist before sending. Reuse this exact key and unchanged input after an uncertain reply.");
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const absoluteExpiry = z.string().datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Use a canonical UTC timestamp including milliseconds; retain exact input for same-key recovery.");
const object = z.record(z.string(), JsonSchema);
const scope = ScopeSchema.shape;
const page = { cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(20).default(10) };
const sourcePath = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:ts|js|mjs)$/).refine(path => path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith(".")), "Use a visible relative source name without traversal.");
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutate = { ...write, destructiveHint: true };
const query = (value) => new URLSearchParams(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
function bounded(value, maxBytes = 4096) {
    if (value === undefined)
        return null;
    const text = JSON.stringify(value), bytes = Buffer.byteLength(text);
    return bytes <= maxBytes ? value : { omitted: true, bytes, sha256: createHash("sha256").update(text).digest("hex"), reason: "operator_context_bound", repair: "Use the exact authorized API resource for full retained data; do not repeat the operation." };
}
function compactBuild(build, input) {
    const { manifest, view, datasetPolicy, failure, ...metadata } = build;
    return { ...metadata, failure: readServiceBuildFailure(failure), service: { id: manifest.id, version: manifest.version, operations: manifest.operations.map((op) => ({ id: op.id, idempotency: op.idempotency, fidelity: op.fidelity })) },
        datasetPolicy: datasetPolicy ? { declared: true, constraints: datasetPolicy.constraints.length, digest: build.datasetPolicyDigest } : null,
        ...(input?.includeManifest ? { manifest: bounded(manifest, 65536), view: bounded(view, 8192), datasetPolicy: bounded(datasetPolicy ?? null, 32768) } : {}),
        ...(input?.operationId ? { operation: bounded(manifest.operations.find((op) => op.id === input.operationId) ?? null, 65536) } : {}),
        sourceIncluded: false };
}
function compactHistory(page) {
    return { ...page, items: page.items.map((item) => ({ ...item, payload: bounded(item.payload) })) };
}
function compactInvocation(value) {
    if (!value.result || typeof value.result !== "object")
        return value;
    const { evidence, invocation, outcome, ...rest } = value.result;
    return { ...value, result: { ...bounded(rest, 8192),
            ...(invocation ? { invocation: bounded(invocation, 8192) } : {}),
            ...(outcome ? { outcome: { ...outcome, ...(Object.hasOwn(outcome, "value") ? { value: bounded(outcome.value, 32768) } : {}), ...(outcome.error ? { error: bounded(outcome.error, 8192) } : {}) } } : {}),
            ...(Array.isArray(evidence) ? { evidence: { entries: evidence.length, firstSequence: evidence[0]?.sequence ?? null, lastSequence: evidence.at(-1)?.sequence ?? null, retained: true, read: "firedrill_service_read action=history" } } : {}) } };
}
function compactCatalogRelease(value) {
    return { id: value.id, name: value.name, version: value.version, releaseDigest: value.releaseDigest, description: bounded(value.description),
        operations: bounded(value.operations.map(operation => ({ id: operation.id, description: operation.description })), 32768),
        fidelity: { interfaces: value.fidelity.interfaces, providerNativeHttp: value.fidelity.providerNativeHttp, vendorUi: value.fidelity.vendorUi, description: bounded(value.fidelity.description) },
        starter: { records: value.starter.records, initialVirtualTimeUs: value.starter.initialVirtualTimeUs, synthetic: value.starter.synthetic }, license: value.license };
}
function compactAcquisition(value) {
    return { schemaVersion: value.schemaVersion, id: value.id, projectId: value.projectId, environmentId: value.environmentId,
        catalogId: value.catalogId, releaseDigest: value.releaseDigest, initialData: value.initialData, phase: value.phase, buildId: value.buildId, datasetId: value.datasetId,
        error: value.error ? { code: value.error.code, repair: bounded(value.error.repair) } : null, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
/** Preserve real startup observations; large replies disclose omitted identities
 * and the unchanged customer-retained intent rather than discard all success. */
function compactToolStart(value, plan, apiUrl) {
    const projected = { ...value, projection: "2026-10-16-tool-start-operator.1",
        items: value.items.map(item => ({ alias: item.alias, phase: item.phase,
            ...(item.acquisitionId ? { acquisitionId: item.acquisitionId } : {}),
            ...(item.buildId ? { buildId: item.buildId } : {}), ...(item.datasetId ? { datasetId: item.datasetId } : {}),
            ...(item.instanceObservation ? { instanceObservation: item.instanceObservation } : {}),
            ...(item.instance ? { instance: { id: item.instance.id, buildId: item.instance.buildId,
                    status: item.instance.status, epoch: item.instance.epoch, seed: item.instance.seed,
                    datasetId: item.instance.datasetId, expiresAt: item.instance.expiresAt,
                    actorOperationCount: item.instance.actorOperations.length,
                    representation: "instance_metadata_not_complete_contract",
                    read: { tool: "firedrill_service_read", arguments: { request: { action: "instance",
                                projectId: value.projectId, environmentId: value.environmentId, instanceId: item.instance.id } } } } } : {}),
            ...(item.access && item.phase === "ready" && item.instanceObservation?.state === "confirmed" ? { access: item.access } : {}),
            ...(item.error ? { error: { code: item.error.code, message: bounded(item.error.message, 512), repair: bounded(item.error.repair, 2048),
                    ...(item.error.buildId ? { buildId: item.error.buildId } : {}), ...(item.error.failure ? { failure: readServiceBuildFailure(item.error.failure) } : {}) } } : {}),
        })),
        representation: { completeInstancesIncluded: false,
            note: "Every setup item is included, not a sample. Read an exact instance only when needed. Unconfirmed metadata is last-observed, not current availability; only a confirmed ready item advertises access. No connection credential or target execution is implied." },
    };
    const serialized = JSON.stringify(projected);
    if (Buffer.byteLength(serialized) <= 100000)
        return projected;
    const canonical = (input) => Array.isArray(input) ? `[${input.map(canonical).join(",")}]`
        : input !== null && typeof input === "object" ? `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(",")}}` : JSON.stringify(input);
    const intent = { apiUrl, projectId: value.projectId, environmentId: value.environmentId, operationKey: value.operationKey, plan };
    const identities = value.items.map(item => ({ alias: item.alias, phase: item.phase,
        ...(item.instance ? { instanceId: item.instance.id } : {}), ...(item.buildId ? { buildId: item.buildId } : {}),
        ...(item.datasetId ? { datasetId: item.datasetId } : {}), ...(item.acquisitionId ? { acquisitionId: item.acquisitionId } : {}),
        ...(item.instanceObservation ? { instanceObservation: item.instanceObservation } : {}), ...(item.error ? { errorCode: item.error.code } : {}) }));
    const summary = { schemaVersion: value.schemaVersion, projection: "2026-10-18-tool-start-operator.2", projectId: value.projectId, environmentId: value.environmentId,
        operationKey: value.operationKey, status: value.status, targetStarted: false, policy: bounded(value.policy, 8192),
        phaseCounts: value.items.reduce((counts, item) => { counts[item.phase] = (counts[item.phase] ?? 0) + 1; return counts; }, {}),
        items: [], representation: { completeInstancesIncluded: false, allSetupItemsIncluded: false, totalItems: identities.length, shownItems: 0, omittedItems: identities.length,
            fullProjection: { bytes: Buffer.byteLength(serialized), sha256: createHash("sha256").update(serialized).digest("hex"), hashFormat: "utf8_JSON_stringify_projection" },
            note: "Items contain real minimal identities; omittedItems states whether this is only a prefix. Counts cover every returned setup item. Omitted identities are not failures or nonexistent resources; no current access or target execution is inferred." },
        originalIntent: { sha256: createHash("sha256").update(canonical(intent)).digest("hex"), hashFormat: "utf8_sorted_key_JSON_of_apiUrl_scope_operationKey_normalized_plan", planIncluded: false, planRequired: "original_unchanged_customer_retained_plan" },
        continuation: { kind: "native_original_intent", replace: ["ORIGINAL_PLAN.json"],
            argv: ["firedrill", "tools", "start", "ORIGINAL_PLAN.json", "--idempotency-key", value.operationKey, "--api-url", apiUrl, "--project", value.projectId, "--environment", value.environmentId, "--json", "--non-interactive"],
            sdk: { typescript: "client.services.start(originalPlan, { operationKey: savedKey })", python: "client.services.start(original_plan, operation_key=saved_key)" },
            note: "Use the original unchanged plan/key and authorized identity/scope. Native reconciliation reuses exact service receipts and may finish pending allocations in that original intent; it is not read-only and never starts a target or invents replacement instances. CLI plan files have a 256 KiB input bound; use a native SDK for larger retained plans. No remote customer-machine journal or single group-read endpoint is implied." },
        readShownInstance: { tool: "firedrill_service_read", replace: ["INSTANCE_ID_FROM_SHOWN_ITEM"], arguments: { request: { action: "instance", projectId: value.projectId, environmentId: value.environmentId, instanceId: "INSTANCE_ID_FROM_SHOWN_ITEM" } } }, };
    for (const item of identities) {
        summary.items.push(item);
        summary.representation.shownItems++;
        summary.representation.omittedItems--;
        if (Buffer.byteLength(JSON.stringify(summary)) > 100000) {
            summary.items.pop();
            summary.representation.shownItems--;
            summary.representation.omittedItems++;
            break;
        }
    }
    summary.representation.allSetupItemsIncluded = summary.representation.omittedItems === 0;
    return summary;
}
export function registerServiceTools(server, options) {
    const { principal, request, safe } = options;
    if (principal.capabilities.includes("read"))
        server.registerTool("firedrill_service_read", {
            description: "Discover qualified built-in catalog metadata, exact acquisition receipts and project-owned service builds/datasets; inspect environment-owned instances/history or retained run-service evidence. Catalog metadata has no pagination; other declared pages are bounded. Explicit scope, no source/credential dumps. Read build includeManifest or one operationId for authoritative authored contracts. Tools remain optional; missing services can be privately authored.",
            inputSchema: z.object({ request: z.discriminatedUnion("action", [
                    z.object({ action: z.literal("catalog"), ...scope }).strict(),
                    z.object({ action: z.literal("catalog_release"), ...scope, catalogId }).strict(),
                    z.object({ action: z.literal("catalog_acquisition"), ...scope, acquisitionId: id }).strict(),
                    z.object({ action: z.literal("catalog_acquisition_by_key"), ...scope, operationKey: key }).strict(),
                    z.object({ action: z.literal("builds"), ...scope, ...page }).strict(),
                    z.object({ action: z.literal("build"), ...scope, buildId: id, includeManifest: z.boolean().default(false), operationId: operationId.optional() }).strict(),
                    z.object({ action: z.literal("datasets"), ...scope, ...page, buildId: id.optional() }).strict(),
                    z.object({ action: z.literal("dataset"), ...scope, datasetId: id, includeRecords: z.boolean().default(false), ...page }).strict(),
                    z.object({ action: z.literal("instances"), ...scope, ...page }).strict(),
                    z.object({ action: z.literal("instance_history"), ...scope, lifecycle: z.enum(["active", "history", "all"]).default("active"), cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(100).default(25) }).strict(),
                    z.object({ action: z.literal("instance"), ...scope, instanceId: id }).strict(),
                    z.object({ action: z.literal("history"), ...scope, instanceId: id, ...page }).strict(),
                    z.object({ action: z.literal("observation"), ...scope, instanceId: id, epoch: epoch.optional(), ...page, evidenceCursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict(),
                    z.object({ action: z.literal("pending"), ...scope, instanceId: id, epoch: epoch.optional(), ...page }).strict(),
                    z.object({ action: z.literal("conformance"), ...scope, receiptId: id }).strict(),
                    z.object({ action: z.literal("run_services"), ...scope, runId: id }).strict(),
                    z.object({ action: z.literal("run_evidence"), ...scope, runId: id, bindingId: id, source: z.enum(["runtime", "history"]).default("runtime"), ...page }).strict(),
                ]) }).strict(), annotations: read,
        }, ({ request: input }) => safe(async () => {
            switch (input.action) {
                case "catalog": {
                    const value = await request("GET", `/v1/service-catalog?${query({ projectId: input.projectId, environmentId: input.environmentId })}`);
                    return { schemaVersion: value.schemaVersion, items: value.items.map(compactCatalogRelease) };
                }
                case "catalog_release": return compactCatalogRelease(await request("GET", `/v1/service-catalog/${input.catalogId}?${query({ projectId: input.projectId, environmentId: input.environmentId })}`));
                case "catalog_acquisition": return compactAcquisition(await request("GET", `/v1/service-catalog/acquisitions/${input.acquisitionId}?${query({ projectId: input.projectId, environmentId: input.environmentId })}`));
                case "catalog_acquisition_by_key": return compactAcquisition(await request("GET", `/v1/service-catalog/acquisitions/by-key?${query({ projectId: input.projectId, environmentId: input.environmentId, key: input.operationKey })}`));
                case "builds":
                case "datasets":
                case "instances": {
                    const { action, ...parameters } = input;
                    return request("GET", `/v1/service-${action}?${query(parameters)}`);
                }
                case "instance_history": {
                    const { action: _, ...parameters } = input;
                    return request("GET", `/v1/service-instances?${query({ ...parameters, order: "newest" })}`);
                }
                case "build": return compactBuild(await request("GET", `/v1/service-builds/${input.buildId}?${query({ projectId: input.projectId, environmentId: input.environmentId })}`), input);
                case "dataset": {
                    const { action: _, datasetId, ...parameters } = input;
                    const value = await request("GET", `/v1/service-datasets/${datasetId}?${query(parameters)}`);
                    return { ...value, ...(value.recordPage ? { recordPage: { ...value.recordPage, items: value.recordPage.items.map((item) => ({ ...item, value: bounded(item.value) })) } } : {}) };
                }
                case "instance": return request("GET", `/v1/service-instances/${input.instanceId}?${query({ projectId: input.projectId, environmentId: input.environmentId })}`);
                case "history": {
                    const { action: _, instanceId, ...parameters } = input;
                    return compactHistory(await request("GET", `/v1/service-instances/${instanceId}/history?${query(parameters)}`));
                }
                case "observation":
                case "pending": {
                    const { action, instanceId, ...parameters } = input;
                    const value = await request("GET", `/v1/service-instances/${instanceId}/${action}?${query(parameters)}`, undefined, undefined, 3 * 1024 * 1024);
                    const compactPage = (page) => ({ ...page, items: page.items.map((item) => bounded(item, 1024)) });
                    return action === "pending" ? compactPage(value) : { ...value, state: compactPage(value.state), pendingWork: compactPage(value.pendingWork), activity: compactPage(value.activity),
                        representation: "bounded_operator_view_digests_identify_original_service_pages", repair: "Follow nextCursor for state/pending and evidenceCursor for activity while retaining epoch. Omitted record bytes remain available through the scoped SDK/API." };
                }
                case "conformance": {
                    const value = await request("GET", `/v1/service-conformance/${input.receiptId}?${query({ projectId: input.projectId, environmentId: input.environmentId })}`, undefined, undefined, 3 * 1024 * 1024);
                    return { ...value, receipt: { ...value.receipt, cases: value.receipt.cases.map((item) => ({ ...item, steps: bounded(item.steps, 4096) })) } };
                }
                case "run_services": return request("GET", `/v1/runs/${input.runId}/services?${query({ projectId: input.projectId, environmentId: input.environmentId })}`);
                case "run_evidence": {
                    const retained = await request("GET", `/v1/runs/${input.runId}/services/${input.bindingId}?${query({ projectId: input.projectId, environmentId: input.environmentId })}`, undefined, undefined, 9 * 1024 * 1024);
                    const { evidence, history, ...metadata } = retained.receipt, entries = input.source === "runtime" ? evidence : history;
                    const items = entries.slice(input.cursor, input.cursor + input.limit).map((entry, index) => ({ index: input.cursor + index, entry: bounded(entry) }));
                    return { ...metadata, digest: retained.digest, source: input.source, totalRetainedEntries: entries.length, items, nextCursor: input.cursor + input.limit < entries.length ? input.cursor + input.limit : null,
                        note: "This pages the retained bounded closure, not omitted disk evidence. evidenceComplete=false remains incomplete." };
                }
            }
        }));
    if (options.readonly)
        return;
    if (principal.capabilities.includes("services:create"))
        server.registerTool("firedrill_tools_start", {
            description: "Start optional named manual Tool instances from pinned catalog releases or saved private builds. Duplicate Tools use distinct aliases. Validate every selection/dataset before allocation; partial success is retained. Persist exact plan and operationKey before calling; retry only that unchanged intent. No target agent or connection credential is created. Remote MCP has no durable customer-machine journal: your saved plan/key and service idempotency receipts are the recovery authority. Native CLI/SDK start adds an automatic private local journal. Only authored semantic/HTTP/MCP/UI interfaces are available.",
            inputSchema: ScopeSchema.extend({ operationKey: key, waitTimeoutMs: z.number().int().min(0).max(300000).default(30000), plan: z.object({ schemaVersion: z.literal("2026-10-15-tool-start.1").optional(), tools: z.array(z.object({
                        alias: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("catalog"), catalogId, releaseDigest }).strict(), z.object({ kind: z.literal("build"), buildId: id }).strict()]),
                        data: z.discriminatedUnion("kind", [z.object({ kind: z.literal("empty") }).strict(), z.object({ kind: z.literal("starter") }).strict(), z.object({ kind: z.literal("saved"), datasetId: id }).strict()]),
                        operations: z.array(operationId).min(1).max(256), seed: z.string().regex(/^(0|[1-9][0-9]*)$/).max(80).optional(), ttlSeconds: z.number().int().min(1).max(604800).optional(),
                    }).strict()).min(1) }).strict() }).strict(), annotations: write,
        }, ({ projectId, environmentId, plan, operationKey, waitTimeoutMs }) => safe(async () => {
            const normalized = validateToolStartPlan(plan);
            const selected = { projectId, environmentId };
            const services = new FiredrillServices(() => selected, async (method, path, body, key) => {
                try {
                    return await request(method, path, body, key);
                }
                catch (error) {
                    if (error instanceof FiredrillError)
                        throw error;
                    const response = error;
                    const detail = response?.publicError;
                    if (detail)
                        throw new FiredrillError(detail.code, detail.message, detail.repair, { status: response.responseStatus ?? detail.status, ...(detail.uncertain === true ? { uncertain: true } : {}) });
                    throw error;
                }
            });
            return compactToolStart(await executeToolStart(services, selected, options.apiUrl, normalized, { operationKey, waitTimeoutMs }), normalized, options.apiUrl);
        }));
    if (principal.capabilities.includes("services:publish"))
        server.registerTool("firedrill_service_conformance", {
            description: "Run supplied operation/expectation fixtures against an exact private service build in isolated disposable instances. Retains a receipt; does not change publication status or claim universal service fidelity. This executes authored service code, not the customer agent. Save operationKey and unchanged input for exact recovery.",
            inputSchema: ScopeSchema.extend({ buildId: id, operationKey: key, suite: z.object({ schemaVersion: z.literal(1), cases: z.array(z.object({
                        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), seed: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(), actorOperations: z.array(operationId).max(256),
                        records: z.array(z.object({ namespace: z.string().max(96), rowId: z.string().max(512), value: object }).strict()).max(1000).optional(),
                        steps: z.array(z.object({ operationId, arguments: object, expect: z.array(z.object({ path: z.string().max(512), expected: JsonSchema }).strict()).min(1).max(16) }).strict()).min(1).max(16),
                    }).strict()).min(1).max(20) }).strict() }).strict(), annotations: write,
        }, ({ projectId, environmentId, buildId, operationKey, suite }) => safe(async () => {
            if (Buffer.byteLength(JSON.stringify(suite)) > 1048576)
                throw Object.assign(new Error("Conformance input exceeds one MiB."), { publicError: { code: "FD_MCP_SOURCE_BOUND", message: "Conformance input exceeds one MiB; no request was sent.", repair: "Select fewer supplied fixtures." } });
            const value = await request("POST", `/v1/service-builds/${buildId}/conformance?${query({ projectId, environmentId })}`, suite, operationKey, 3 * 1024 * 1024);
            return { ...value, receipt: { ...value.receipt, cases: value.receipt.cases.map((item) => ({ ...item, steps: bounded(item.steps, 4096) })) } };
        }));
    if (principal.capabilities.includes("services:publish"))
        server.registerTool("firedrill_service_acquire", {
            description: "Acquire one exact qualified built-in release into the selected project's private build and explicitly empty or synthetic starter dataset. Requires the releaseDigest returned by catalog discovery and a saved operationKey. This publishes project-owned IDs only; it does not allocate an instance, issue a grant or execute an agent. Retain partial/uncertain receipts; recover with catalog_acquisition_by_key using the same scope/key, never silently select latest or create a replacement. Tool fidelity is limited to its declared semantic/MCP subset and read-only record UI, not vendor REST/UI emulation.",
            inputSchema: ScopeSchema.extend({ catalogId, releaseDigest, initialData: z.enum(["empty", "starter"]), operationKey: key }).strict(), annotations: write,
        }, ({ operationKey, ...body }) => safe(async () => compactAcquisition(await request("POST", "/v1/service-catalog/acquisitions", body, operationKey))));
    if (principal.capabilities.includes("services:publish"))
        server.registerTool("firedrill_service_publish", {
            description: "Publish explicitly supplied private service source or an immutable seed dataset. Optional datasetPolicy checks declared uniqueness/references/counts; dataset metadata records caller-declared provenance and same-scope version-pinned cross-dataset mappings. Schema/domain/mapping validation is not vendor fidelity or independently verified import consent. Never reads host/repository paths. Returns retained IDs/digests and validation metadata, not source. Does not allocate an instance or run an agent.",
            inputSchema: z.object({ request: z.discriminatedUnion("action", [
                    z.object({ action: z.literal("build"), ...scope, entryPoint: sourcePath, manifest: object, view: object.optional(), conformance: object.optional(), datasetPolicy: DatasetPolicySchema.optional(), files: z.array(z.object({ path: sourcePath, content: z.string().max(1048576) }).strict()).min(1).max(128), operationKey: key }).strict(),
                    z.object({ action: z.literal("dataset"), ...scope, buildId: id, records: z.array(z.object({ namespace: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(96), rowId: z.string().min(1).max(512), value: object }).strict()).max(10000), initialVirtualTimeUs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), metadata: DatasetMetadataSchema.optional(), operationKey: key }).strict(),
                ]) }).strict(), annotations: write,
        }, ({ request: { action, operationKey, ...body } }) => safe(async () => {
            if (Buffer.byteLength(JSON.stringify(body)) > 3 * 1024 * 1024)
                throw Object.assign(new Error("Inline publication exceeds the MCP request bound."), { publicError: { code: "FD_MCP_SOURCE_BOUND", message: "Inline publication exceeds this MCP transport's 3 MiB JSON bound; no request was sent.", repair: "Reduce the explicitly selected source/seed records, or use the scoped CLI/SDK publication path." } });
            const value = await request("POST", `/v1/service-${action === "build" ? "builds" : "datasets"}`, body, operationKey);
            return action === "build" ? compactBuild(value) : value;
        }));
    if (principal.capabilities.includes("services:create"))
        server.registerTool("firedrill_service_create", {
            description: "Allocate one manual service instance from an exact immutable build and optional dataset, explicit seed and actor operations. This consumes bounded service capacity, not a payment. No sample data/actor is inferred. For independent recipe cases bind services in the recipe instead; the runner allocates isolated run-owned instances.",
            inputSchema: ScopeSchema.extend({ buildId: id, datasetId: id.optional(), seed: z.string().regex(/^(0|[1-9][0-9]*)$/).max(80), actorOperations: z.array(operationId).min(1).max(256), ttlSeconds: z.number().int().min(1).max(604800).optional(), operationKey: key }).strict(), annotations: write,
        }, ({ operationKey, ...body }) => safe(() => request("POST", "/v1/service-instances", body, operationKey)));
    if (principal.capabilities.includes("services:invoke"))
        server.registerTool("firedrill_service_invoke", {
            description: "Invoke one authored operation on a manual instance at its exact epoch. May mutate canonical state/events. Explicit request operationKey enables durable reply recovery; authoredIdempotencyKey separately satisfies a manifest operation's required/optional idempotency contract. A manual probe is not target execution or assessment evidence. Run-owned instances reject this operator path.",
            inputSchema: ScopeSchema.extend({ instanceId: id, epoch, operationId, arguments: object, operationKey: key, authoredIdempotencyKey: key.optional() }).strict(), annotations: mutate,
        }, ({ projectId, environmentId, instanceId, operationKey, authoredIdempotencyKey, ...body }) => safe(async () => compactInvocation(await request("POST", `/v1/service-instances/${instanceId}/invoke?${query({ projectId, environmentId })}`, { ...body, ...(authoredIdempotencyKey ? { operationKey: authoredIdempotencyKey } : {}) }, operationKey))));
    if (principal.capabilities.includes("services:control"))
        server.registerTool("firedrill_service_control", {
            description: "Control an exact manual service instance/epoch: snapshot, reset or rewind, advance virtual clock, pause, resume, extend lifetime, or destroy resources while retaining history. Reset and rewind are aliases restoring the selected snapshot's modeled state, clock, pending work and randomness; they increment epoch, fence old grants and preserve history. They do not reset external agents, application databases or provider state. Extend requires exact observed/new UTC expiries; it does not resume compute, renew grants or extend target runtime. Retain exact input/key for recovery. Clock dispatch may mutate state. Destroy is not record deletion. Run-owned lifecycle rejects this path. No grant/credential creation is exposed.",
            inputSchema: z.object({ request: z.discriminatedUnion("action", [
                    z.object({ action: z.enum(["snapshot", "pause", "resume", "destroy"]), ...scope, instanceId: id, epoch, operationKey: key }).strict(),
                    z.object({ action: z.enum(["reset", "rewind"]), ...scope, instanceId: id, epoch, snapshotId: id, operationKey: key }).strict(),
                    z.object({ action: z.literal("clock"), ...scope, instanceId: id, epoch, toUs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), maxEvents: z.number().int().min(1).max(1000).optional(), operationKey: key }).strict(),
                    z.object({ action: z.literal("extend"), ...scope, instanceId: id, epoch, expectedExpiresAt: absoluteExpiry, expiresAt: absoluteExpiry, operationKey: key }).strict(),
                ]) }).strict(), annotations: mutate,
        }, ({ request: { action, projectId, environmentId, instanceId, operationKey, ...body } }) => safe(async () => compactInvocation(await request("POST", `/v1/service-instances/${instanceId}/${action}?${query({ projectId, environmentId })}`, body, operationKey))));
}

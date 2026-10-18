import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CONTRACT_VERSION, TARGET_EXECUTION_VERSION, RecipeSchema, JsonSchema, ReassessmentSchema, readValidationDiagnostics } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";
import { normalizeApiUrl, resolveApiUrl } from "./api-origin.js";
export { FIREDRILL_API_ORIGIN, normalizeApiUrl, resolveApiUrl } from "./api-origin.js";
import { readServiceBuildErrorDetails } from "./service-build-diagnostics.js";
import { JournalStore } from "./journal.js";
import { event, executeTarget } from "./targets.js";
import { prepareRunTools, redactToolSecrets } from "./run-tools.js";
import { attachmentCoordinator } from "./attachments.js";
import { readArtifacts, readArtifactContent, saveArtifactContent } from "./artifact-downloads.js";
import { liveEvents, flushLiveEvents } from "./live-events.js";
import { FiredrillServices } from "./services.js";
import { FiredrillInterventions } from "./interventions.js";
import { executeSequence } from "./sequences.js";
import { reconcileIsolatedExecution } from "./isolated.js";
import { FiredrillCredentials } from "./credentials.js";
import { FiredrillCapacity } from "./capacity.js";
import { readCapacityRequestAction } from "../contracts/index.js";
import { FiredrillRetention } from "./retention.js";
import { readJsonInput, readPublicConfig } from "./input-files.js";
import { FiredrillLogin } from "./login.js";
import { PREPARATION_VERSION, ScenarioSaveSchema } from "../contracts/index.js";
import { InspectionFiltersSchema, ScenarioFiltersSchema, inspectionFilterQuery } from "../contracts/index.js";
import { PopulationMaterializeSchema, POPULATION_VERSION } from "../contracts/index.js";
import { retainedValuePath, operatorReportPath, operatorBatchPath } from "./retained-values.js";
import { authoringSchemaPath, requireDiscoveryVersion } from "./discovery.js";
import { newSubmission, matchRetainedSubmission } from "./ci-context.js";
import { writeCiReport } from "./ci-report.js";
import { activityReportQuery, confirmActivitySelection } from "./activity.js";
import { followBatch } from "./follow.js";
import { submitBatch, resumeBatchSubmission } from "./submission.js";
import { isScopedResourceRead, readScopeHeaders, readScopeConfirmed, RESULT_LIFECYCLE_VERSION } from "../contracts/index.js";
function checkedInspectionFilters(value) {
    const parsed = InspectionFiltersSchema.safeParse(value);
    if (!parsed.success)
        throw definitionError("FILTER_INVALID", "Inspection filters are invalid.", "Use a literal prefix, valid UTC dates (year 0001–9999, at most 3 fractional digits), and below_level with dimensionId and minimumLevel 0–4. Clear cursor when changing filters. No request was sent.", parsed.error.issues);
    return parsed.data;
}
export { SERVICE_BUILD_DIAGNOSTICS_VERSION, readServiceBuildFailure } from "./service-build-diagnostics.js";
export { CI_CONTEXT_VERSION, CI_REPORT_VERSION } from "../contracts/index.js";
export { ACTIVITY_VERSION } from "../contracts/index.js";
export { FOLLOW_VERSION, followBatch } from "./follow.js";
export { SUBMISSION_RECEIPT_VERSION, SubmissionError } from "./submission.js";
export { batchReceipt, BATCH_RECEIPT_VERSION } from "./batch-receipt.js";
export { RESULT_LIFECYCLE_VERSION } from "../contracts/index.js";
export { BATCH_OVERVIEW_VERSION } from "../contracts/index.js";
export { RETAINED_VALUE_VERSION, OPERATOR_DOCUMENT_VERSION } from "./retained-values.js";
export { FiredrillLogin } from "./login.js";
export { FiredrillCredentials, IssuedCredential } from "./credentials.js";
export { FiredrillCapacity } from "./capacity.js";
export { FiredrillRetention, RETENTION_VERSION } from "./retention.js";
export { FiredrillServices, ConnectionGrant } from "./services.js";
export { FiredrillInterventions } from "./interventions.js";
export { executeToolStart, validateToolStartPlan } from "./tool-start.js";
export { DATASET_POLICY_VERSION, DATASET_METADATA_VERSION, DATASET_VALIDATION_VERSION } from "../contracts/index.js";
export { FiredrillError, CLIENT_DIAGNOSTICS_VERSION } from "./errors.js";
export { TARGET_INVOCATION_VERSION } from "../contracts/index.js";
export { DISCOVERY_VERSION, AUTHORING_SCHEMA_IDS } from "../contracts/index.js";
export { RunTool } from "./run-tools.js";
export { TARGET_METADATA_VERSION } from "../contracts/index.js";
export { TARGET_EXECUTION_VERSION, TargetExecutionPolicySchema } from "../contracts/index.js";
export { RUN_MEASUREMENTS_VERSION } from "../contracts/index.js";
export { REPORT_LINK_VERSION } from "../contracts/index.js";
export { READ_SCOPE_VERSION } from "../contracts/index.js";
export { NUMERIC_CHECK_VERSION } from "../contracts/index.js";
export { TASK_METRIC_VERSION, TaskMetricDefinitionSchema } from "../contracts/index.js";
export { COMPOSITE_VERSION } from "../contracts/index.js";
export { POPULATION_PURPOSE_VERSION, POPULATION_DISCLOSURE_VERSION, PopulationPurposeSchema } from "../contracts/index.js";
export { ASSESSMENT_POLICY_VERSION, SERVICE_CONTROL_VERSION, SERVICE_CONTROL_CLOCK_VERSION } from "../contracts/index.js";
function simulationResult(result, operationId, ci) {
    const ciReport = writeCiReport(result, ci);
    return { ...result, operationId, ...(ciReport ? { ciReport } : {}) };
}
function terminal(run) { return !["queued", "running"].includes(run.execution); }
function id(value) { return encodeURIComponent(value); }
export class Firedrill {
    #apiUrl;
    get apiUrl() { return this.#apiUrl; }
    projectId;
    environmentId;
    #token;
    #loginIdentity;
    #loginIdentityChanged = false;
    options;
    /** Explicit repo selection. No browser, imports or ancestor search; credentials never come from this file. */
    static fromConfig(path = "firedrill.config.json", overrides = {}) {
        const config = readPublicConfig(path);
        for (const [key, variable] of [["apiUrl", "FIREDRILL_API_URL"], ["projectId", "FIREDRILL_PROJECT_ID"], ["environmentId", "FIREDRILL_ENVIRONMENT_ID"]]) {
            const normalize = (value) => key === "apiUrl" ? normalizeApiUrl(value) : value;
            const selections = [config[key], overrides[key], process.env[variable]].filter((value) => value !== undefined);
            if (selections.some(value => typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)))
                throw new FiredrillError("CONFIG_INVALID", "Explicit scope selections must be nonempty strings.", "Remove invalid or empty scope overrides; no request was sent.");
            if (new Set(selections.map(normalize)).size > 1)
                throw new FiredrillError("SCOPE_CONFLICT", `Selected ${key} disagrees across config, options or environment.`, "Use one consistent API/project/environment selection. No request was sent.");
        }
        const client = new Firedrill({ ...config, ...overrides });
        if (Boolean(client.projectId) !== Boolean(client.environmentId))
            throw new FiredrillError("SCOPE_REQUIRED", "Select a project and its environment together.", "Run firedrill init or provide both selected IDs.");
        return client;
    }
    constructor(options = {}) {
        const { token: _token, ...safeOptions } = options;
        const journalDirectory = options.journalDirectory ?? process.env.FIREDRILL_JOURNAL_DIRECTORY;
        if (journalDirectory !== undefined && (typeof journalDirectory !== "string" || !journalDirectory.trim() || journalDirectory.includes("\0")))
            throw new FiredrillError("JOURNAL_UNSAFE", "The selected recovery directory is empty or invalid.", "Set FIREDRILL_JOURNAL_DIRECTORY to a private owned directory, or pass journalDirectory explicitly.");
        this.options = { ...safeOptions, journalDirectory };
        this.#apiUrl = resolveApiUrl(options.apiUrl);
        this.#token = options.token ?? process.env.FIREDRILL_TOKEN;
        if (this.#token !== undefined && (typeof this.#token !== "string" || !this.#token || /[\s\x00-\x1f\x7f]/.test(this.#token) || this.#token.length > 8192))
            throw new FiredrillError("AUTH_REQUIRED", "The explicitly selected Firedrill credential is invalid.", "Correct or unset the explicit token. A protected login never silently replaces an explicit token.");
        this.projectId = options.projectId ?? process.env.FIREDRILL_PROJECT_ID;
        this.environmentId = options.environmentId ?? process.env.FIREDRILL_ENVIRONMENT_ID;
    }
    scope() {
        if (typeof this.projectId !== "string" || typeof this.environmentId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(this.projectId) || !/^[A-Za-z0-9_-]{1,160}$/.test(this.environmentId))
            throw new FiredrillError("SCOPE_REQUIRED", "Select a valid project and environment before accessing project resources.", "Run firedrill init or pass projectId and environmentId. No other context is selected automatically.");
        return { projectId: this.projectId, environmentId: this.environmentId };
    }
    authToken() {
        if (this.#token !== undefined)
            return Promise.resolve(this.#token);
        const confirm = (credential) => {
            if (this.#loginIdentity && (!credential || credential.id !== this.#loginIdentity.id || credential.organizationId !== this.#loginIdentity.organizationId))
                this.#loginIdentityChanged = true;
            if (this.#loginIdentityChanged)
                throw new FiredrillError("FD_SDK_IDENTITY_CHANGED", "This client's protected Firedrill sign-in has changed.", "Stop this client. Explicitly verify the intended account, organization and project/environment before creating a new client. Recover existing work with its original identity; do not start another target to recover it.");
            if (credential)
                this.#loginIdentity ??= { id: credential.id, organizationId: credential.organizationId };
        };
        if (this.#loginIdentityChanged)
            confirm();
        return new FiredrillLogin({ apiUrl: this.apiUrl, storeDirectory: this.options.loginStoreDirectory }).resolveToken(confirm);
    }
    async request(method, path, body, key, readScope) {
        let observedStatus;
        const readOnly = method === "GET" || method === "POST" && ["/v1/recipes/preview", "/v1/recipes/materialize", "/v1/comparisons"].includes(path.split("?")[0]);
        try {
            const selectedRead = isScopedResourceRead(method, path) ? readScope ?? this.scope() : undefined;
            const token = await this.authToken();
            const response = await fetch(`${this.apiUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(selectedRead ? readScopeHeaders(selectedRead) : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30000), redirect: "error" });
            observedStatus = response.status;
            if (response.ok && selectedRead && !readScopeConfirmed(response.headers, selectedRead)) {
                await response.body?.cancel().catch(() => { });
                throw new FiredrillError("FD_READ_SCOPE_UNCONFIRMED", "The service did not confirm this read's selected project/environment.", "Use aligned client/service versions and the original context. No unconfirmed content is returned; do not rerun the target to repair a report read.", { status: response.status, uncertain: false, workStarted: false, retry: "same_request", category: "infrastructure" });
            }
            const reader = response.body?.getReader();
            const chunks = [];
            let length = 0;
            try {
                if (reader)
                    for (;;) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        length += next.value.length;
                        if (length > 32 * 1024 * 1024)
                            throw new Error("response too large");
                        chunks.push(next.value);
                    }
            }
            finally {
                await reader?.cancel().catch(() => { });
            }
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!response.ok) {
                const validation = readValidationDiagnostics(value.error?.validation);
                const buildDetails = value.error?.code === "FD_SERVICE_BUILD_FAILED" ? readServiceBuildErrorDetails(value.error?.details) : {};
                const capacityRequest = readCapacityRequestAction(value.error?.details);
                const uncertain = !readOnly && (response.status >= 500 || /UNCERTAIN|UNCONFIRMED|RECOVERY_REQUIRED|REFRESH_PENDING/i.test(value.error?.code ?? ""));
                throw new FiredrillError(value.error?.code ?? "API_ERROR", value.error?.message ?? "Firedrill rejected the operation.", value.error?.repair ?? "Inspect the retained operation before retrying.", { status: response.status, requestId: value.error?.requestId, uncertain,
                    workStarted: readOnly ? false : "unknown",
                    retry: readOnly ? "same_request" : uncertain ? "reconcile" : "never", ...(validation ? { validation } : {}), ...buildDetails, ...(capacityRequest ? { capacityRequest } : {}) });
            }
            return value;
        }
        catch (error) {
            if (error instanceof FiredrillError)
                throw error;
            throw new FiredrillError("TRANSPORT_UNCERTAIN", "The service response could not be confirmed.", readOnly ? "Repeat this same read-only request; no target or assessment was started by this request." : "Resume the saved operation; do not create another execution to recover this request.", { uncertain: !readOnly, workStarted: readOnly ? false : "unknown", retry: readOnly ? "same_request" : "reconcile", category: readOnly ? "infrastructure" : "uncertain", ...(observedStatus === undefined ? {} : { status: observedStatus }) });
        }
    }
    async uploadArtifact(path, content, mediaType, attemptId, leaseToken) {
        let observedStatus;
        try {
            const token = await this.authToken();
            const response = await fetch(`${this.apiUrl}${path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": mediaType, "x-fd-attempt-id": attemptId, "x-fd-lease-token": leaseToken }, body: new Uint8Array(content), signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30000), redirect: "error" });
            observedStatus = response.status;
            const reader = response.body?.getReader();
            const chunks = [];
            let length = 0;
            try {
                if (reader)
                    for (;;) {
                        const next = await reader.read();
                        if (next.done)
                            break;
                        length += next.value.length;
                        if (length > 1024 * 1024)
                            throw new Error("Artifact acknowledgement too large");
                        chunks.push(next.value);
                    }
            }
            finally {
                await reader?.cancel().catch(() => { });
            }
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!response.ok) {
                const validation = readValidationDiagnostics(value.error?.validation);
                throw new FiredrillError(value.error?.code ?? "API_ERROR", value.error?.message ?? "Firedrill rejected the artifact.", value.error?.repair ?? "Inspect the saved attachment intent.", { status: response.status, requestId: value.error?.requestId, ...(validation ? { validation } : {}) });
            }
            return value;
        }
        catch (error) {
            if (error instanceof FiredrillError)
                throw error;
            throw new FiredrillError("TRANSPORT_UNCERTAIN", "The artifact upload acknowledgement was not confirmed.", "Resume its exact saved intent; never rerun the target.", { uncertain: true, ...(observedStatus === undefined ? {} : { status: observedStatus }) });
        }
    }
    artifactReader() {
        return {
            json: async (path) => {
                try {
                    return await this.request("GET", path);
                }
                catch (error) {
                    if (error instanceof FiredrillError && error.code === "TRANSPORT_UNCERTAIN")
                        throw new FiredrillError("ARTIFACT_READ_UNCONFIRMED", "The retained capture metadata could not be confirmed.", "Retry this same read. It does not execute a target or request evaluation.", { ...error.details, uncertain: false });
                    throw error;
                }
            },
            content: async (path, maximumBytes) => {
                const selected = this.scope();
                let status;
                try {
                    const token = await this.authToken();
                    const response = await fetch(`${this.apiUrl}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "*/*", ...readScopeHeaders(selected) }, redirect: "error", signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30000) });
                    status = response.status;
                    if (response.ok && !readScopeConfirmed(response.headers, selected)) {
                        await response.body?.cancel().catch(() => { });
                        throw new FiredrillError("FD_READ_SCOPE_UNCONFIRMED", "The service did not confirm this capture's selected project/environment.", "Read it using aligned client/service versions and its original scope. No unconfirmed bytes are returned.", { status });
                    }
                    const reader = response.body?.getReader(), parts = [];
                    let bytes = 0;
                    const bound = response.ok ? maximumBytes : 65536;
                    try {
                        if (reader)
                            for (;;) {
                                const part = await reader.read();
                                if (part.done)
                                    break;
                                bytes += part.value.byteLength;
                                if (bytes > bound)
                                    throw new FiredrillError("ARTIFACT_RESPONSE_BOUND", "The artifact response exceeded its retained byte bound.", "Read the same artifact again. No unverified bytes are returned and no target is rerun.", { status });
                                parts.push(part.value);
                            }
                    }
                    finally {
                        await reader?.cancel().catch(() => { });
                    }
                    const content = Buffer.concat(parts);
                    if (!response.ok) {
                        let problem = {};
                        try {
                            const value = JSON.parse(content.toString("utf8"));
                            if (value?.error && typeof value.error === "object" && !Array.isArray(value.error))
                                problem = value.error;
                        }
                        catch { /* A definite HTTP rejection remains a rejection even without JSON. */ }
                        throw new FiredrillError(typeof problem.code === "string" ? problem.code : "ARTIFACT_READ_REJECTED", typeof problem.message === "string" ? problem.message : "The service rejected this artifact read.", typeof problem.repair === "string" ? problem.repair : "Inspect the original run and current read authority. A read retry never requires another target execution.", { status, ...(typeof problem.requestId === "string" ? { requestId: problem.requestId } : {}) });
                    }
                    if (response.status !== 200)
                        throw new FiredrillError("ARTIFACT_RESPONSE_MISMATCH", "The service did not return a complete artifact.", "Request the original artifact again; partial content is not accepted as complete evidence.", { status });
                    return { content, mediaType: response.headers.get("content-type") };
                }
                catch (error) {
                    if (error instanceof FiredrillError)
                        throw error;
                    throw new FiredrillError("ARTIFACT_READ_UNCONFIRMED", "The capture download was not confirmed.", "Retry this same retained artifact read. It does not execute the target or request evaluation.", { uncertain: false, ...(status === undefined ? {} : { status }) });
                }
            },
        };
    }
    /** Retained captures only. Pending files are not available evidence. */
    artifacts(runId) { return readArtifacts(this.artifactReader(), runId); }
    /** Read one bounded, digest-verified capture. No artifact URL or redirect is trusted. */
    artifactContent(runId, artifactId) { return readArtifactContent(this.artifactReader(), runId, artifactId); }
    /** Save one verified capture privately to a new path; never overwrites local files. */
    async downloadArtifact(runId, artifactId, output) {
        return saveArtifactContent(await this.artifactContent(runId, artifactId), output);
    }
    context() { return this.request("GET", "/v1/context"); }
    /** Authenticated metadata, without scope selection, allocation or target invocation. */
    async discover() { return requireDiscoveryVersion(await this.request("GET", "/v1/discovery")); }
    /** Read one canonical structural input schema or an exact node, not private source. */
    async schema(id, options = {}) {
        const path = authoringSchemaPath(id, options);
        return requireDiscoveryVersion(await this.request("GET", path));
    }
    /** Scoped semantic service authoring/control. No private runtime is bundled. */
    get interventions() { return new FiredrillInterventions(() => this.scope(), (method, path, body, key) => this.request(method, path, body, key)); }
    get services() { return new FiredrillServices(() => this.scope(), (method, path, body, key) => this.request(method, path, body, key), { apiUrl: this.apiUrl, journalDirectory: this.options.journalDirectory, identity: async () => { const context = await this.context(); return { id: context.principal.id, organizationId: context.principal.organizationId }; } }); }
    get credentials() { return new FiredrillCredentials(() => this.scope(), (method, path, body, key) => this.request(method, path, body, key)); }
    get capacity() { return new FiredrillCapacity(() => this.scope(), (method, path, body, key) => this.request(method, path, body, key)); }
    get retention() { return new FiredrillRetention(() => this.scope(), (method, path, body, key) => this.request(method, path, body, key)); }
    listProjects() { return this.request("GET", "/v1/projects"); }
    createProject(name, idempotencyKey = randomUUID()) { return this.request("POST", "/v1/projects", { name }, idempotencyKey); }
    status(batchId) { return this.request("GET", `/v1/batches/${id(batchId)}`); }
    /** Observe retained work only; does not claim, cancel, assess or write CI summaries. */
    follow(batchId, options = {}) {
        const scope = this.scope();
        return followBatch(batchId, { scope, read: path => this.request("GET", path, undefined, undefined, scope) }, options);
    }
    async result(batchId) {
        const scope = this.scope();
        try {
            try {
                return await this.request("GET", `/v1/batches/${id(batchId)}/result`, undefined, undefined, scope);
            }
            catch (error) {
                if (!(error instanceof FiredrillError) || error.code !== "FD_RESULT_PAGE_REQUIRED")
                    throw error;
                return await this.request("GET", `/v1/batches/${id(batchId)}/result?compact=1`, undefined, undefined, scope);
            }
        }
        catch (error) {
            if (error instanceof FiredrillError && /^FD_CONTENT_(?:UNAVAILABLE|EXPIRED|DELETED|DELETION_PENDING)$/.test(error.code)) {
                error.details.batchId = batchId;
                try {
                    error.details.retainedLifecycle = await this.readResultLifecycle(batchId, scope);
                }
                catch { /* Metadata expiry or a second read failure never replaces the original error. */ }
            }
            throw error;
        }
    }
    /** Metadata-only lifecycle survives payload expiry while metadata is retained. */
    async resultLifecycle(batchId) {
        return this.readResultLifecycle(batchId, this.scope());
    }
    async readResultLifecycle(batchId, scope) {
        const value = await this.request("GET", `/v1/batches/${id(batchId)}/lifecycle`, undefined, undefined, scope);
        if (!value || value.schemaVersion !== RESULT_LIFECYCLE_VERSION || value.batchId !== batchId
            || value.projectId !== scope.projectId || value.environmentId !== scope.environmentId
            || value.lifecycle?.schemaVersion !== RESULT_LIFECYCLE_VERSION)
            throw new FiredrillError("LIFECYCLE_SCOPE_UNCONFIRMED", "The lifecycle read did not confirm this exact batch and selected scope.", "Read the original batch lifecycle with aligned client/service versions and its original scope. No target was invoked.", { batchId, uncertain: false, workStarted: false, retry: "same_request", category: "infrastructure" });
        return value;
    }
    listBatches(options = {}) {
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
            throw new FiredrillError("PAGE_INVALID", "limit must be between 1 and 100.", "Pass the opaque returned cursor unchanged.");
        const query = new URLSearchParams(this.scope());
        if (options.cursor !== undefined)
            query.set("cursor", options.cursor);
        if (options.limit !== undefined)
            query.set("limit", String(options.limit));
        const { cursor: _cursor, limit: _limit, ...selected } = options;
        for (const [key, value] of Object.entries(inspectionFilterQuery(checkedInspectionFilters(selected))))
            query.set(key, value);
        return this.request("GET", `/v1/batches?${query}`);
    }
    listScenarios(options = {}) {
        const projectId = options.projectId ?? this.projectId;
        if (!projectId)
            throw new FiredrillError("SCOPE_REQUIRED", "Scenario definitions require a selected project.", "Pass projectId or select the project. Definitions are project-owned, not environment execution records.");
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
            throw new FiredrillError("PAGE_INVALID", "limit must be between 1 and 100.", "Use the returned scenario cursor unchanged.");
        const query = new URLSearchParams({ projectId });
        const environmentId = options.environmentId ?? (projectId === this.projectId ? this.environmentId : undefined);
        if (environmentId !== undefined)
            query.set("environmentId", environmentId);
        if (options.cursor !== undefined)
            query.set("cursor", options.cursor);
        if (options.limit !== undefined)
            query.set("limit", String(options.limit));
        const filters = ScenarioFiltersSchema.safeParse({ ...(options.q === undefined ? {} : { q: options.q }) });
        if (!filters.success)
            throw definitionError("FILTER_INVALID", "Scenario prefix is invalid.", "Use a literal name/ID prefix of 1–100 characters. No request was sent.", filters.error.issues);
        if (filters.data.q)
            query.set("q", filters.data.q);
        return this.request("GET", `/v1/scenarios?${query}`);
    }
    scenario(scenarioId, revision, options = {}) {
        const projectId = options.projectId ?? this.projectId;
        if (!projectId)
            throw new FiredrillError("SCOPE_REQUIRED", "Scenario definitions require a selected project.", "Pass projectId and the exact immutable revision from listScenarios.");
        const environmentId = options.environmentId ?? (projectId === this.projectId ? this.environmentId : undefined);
        return this.request("GET", `/v1/scenarios/definition?${new URLSearchParams({ projectId, scenarioId, revision, ...(environmentId !== undefined ? { environmentId } : {}) })}`);
    }
    /** Authenticated, nonallocating estimate. Never calls the supplied target. */
    async preview(input) {
        const value = typeof input === "string" ? readJsonInput(input, 8 * 1024 * 1024, "RECIPE_INVALID") : input;
        const parsed = RecipeSchema.safeParse(value && typeof value === "object" && !Array.isArray(value) ? { schemaVersion: CONTRACT_VERSION, ...value } : value);
        if (!parsed.success)
            throw definitionError("RECIPE_INVALID", "Recipe validation failed.", "Declare an explicit target without invoking it and correct the listed fields. No preview request was sent.", parsed.error.issues);
        try {
            return await this.request("POST", "/v1/recipes/preview", { schemaVersion: PREPARATION_VERSION, ...this.scope(), recipe: parsed.data });
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The read-only preview response was not confirmed.", "Repeat the same preview. It creates no batch, target execution, Tool instance or assessment.", { ...error.details, uncertain: false });
            throw error;
        }
    }
    async saveScenario(scenario, options) {
        if (!options || typeof options.idempotencyKey !== "string" || !options.idempotencyKey.trim() || options.idempotencyKey.length > 200 || /[\r\n]/.test(options.idempotencyKey))
            throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Scenario save needs an explicit stable key of 1–200 characters.", "Retain the key and unchanged scenario/base revision before saving.");
        const parsed = ScenarioSaveSchema.safeParse({ schemaVersion: PREPARATION_VERSION, ...this.scope(), scenario, expectedRevision: options.expectedRevision });
        if (!parsed.success)
            throw definitionError("SCENARIO_INVALID", "Scenario validation failed.", "Correct the listed fields and expectedRevision (null for a new ID). No scenario-save request was sent.", parsed.error.issues);
        try {
            return await this.request("POST", "/v1/scenarios", parsed.data, options.idempotencyKey);
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The scenario-save response was not confirmed.", "Retry the same key and unchanged input/base revision. Do not create a batch to reconcile a scenario save.", error.details);
            throw error;
        }
    }
    /** Deterministic preparation only. Save/inspect the returned explicit recipe before executing it. */
    async materialize(input, options) {
        const value = typeof input === "string" ? readJsonInput(input, 8 * 1024 * 1024, "RECIPE_INVALID") : input;
        const parsed = PopulationMaterializeSchema.safeParse({ ...this.scope(), schemaVersion: POPULATION_VERSION, recipe: value && typeof value === "object" && !Array.isArray(value) ? { schemaVersion: CONTRACT_VERSION, ...value } : value, axes: options?.axes, selection: options?.selection });
        if (!parsed.success)
            throw definitionError("POPULATION_INVALID", "Population preparation is invalid.", "Use input-relative JSON Pointer axes, finite values and a deliberate seed; sample requires count, matrix forbids it. No target was invoked.", parsed.error.issues);
        try {
            return await this.request("POST", "/v1/recipes/materialize", parsed.data);
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The read-only materialization response was not confirmed.", "Repeat the identical source/axes/seed. This creates no batch, service instance or assessment.", { ...error.details, uncertain: false });
            throw error;
        }
    }
    event(runId, eventId) { return this.request("GET", `/v1/runs/${id(runId)}/events/${id(eventId)}`); }
    summary(batchId) { return this.request("GET", `/v1/batches/${id(batchId)}/summary`); }
    async compare(baselineBatchId, candidateBatchId) {
        try {
            return await this.request("POST", "/v1/comparisons", { baselineBatchId, candidateBatchId, selectedScope: this.scope() });
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The read-only comparison response was not confirmed.", "Request the same comparison again. It does not execute targets or create assessments.", { ...error.details, uncertain: false });
            throw error;
        }
    }
    async comparePairs(baselineBatchId, candidateBatchId, options = {}) {
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
            throw new FiredrillError("PAGE_INVALID", "limit must be between 1 and 100.", "Use the returned paired-case cursor unchanged.");
        if (options.cursor !== undefined && (typeof options.cursor !== "string" || options.cursor.length < 1 || options.cursor.length > 512))
            throw new FiredrillError("PAGE_INVALID", "The paired-case cursor must contain 1–512 characters.", "Use the returned paired-case cursor unchanged.");
        const query = new URLSearchParams({ view: "pairs", limit: String(options.limit ?? 25) });
        if (options.cursor !== undefined)
            query.set("cursor", options.cursor);
        try {
            return await this.request("POST", `/v1/comparisons?${query}`, { baselineBatchId, candidateBatchId, selectedScope: this.scope() });
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The read-only paired-case response was not confirmed.", "Request the same paired-case page again. It does not execute targets or create assessments.", { ...error.details, uncertain: false });
            throw error;
        }
    }
    assessments(runId) { return this.request("GET", `/v1/runs/${id(runId)}/assessments`); }
    assessment(runId, assessmentId) { return this.request("GET", `/v1/runs/${id(runId)}/assessments/${id(assessmentId)}`); }
    /** Explicit evaluator action on frozen evidence; never reruns the customer target. */
    async reassess(runId, input, idempotencyKey) {
        if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))
            throw new FiredrillError("IDEMPOTENCY_REQUIRED", "Reassessment needs an explicit stable key of 1–200 characters.", "Retain the key and unchanged rubric; reuse only to reconcile the same evaluator action.");
        const parsed = ReassessmentSchema.omit({ projectId: true, environmentId: true }).safeParse(input);
        if (!parsed.success)
            throw new FiredrillError("REASSESSMENT_INVALID", "Reassessment input must contain only a valid optional rubric.", "Supply {} to reuse the retained rubric, or an explicit versioned rubric. This action may consume platform evaluator budget, not customer target-model budget.");
        try {
            return await this.request("POST", `/v1/runs/${id(runId)}/assessments`, { ...this.scope(), ...parsed.data }, idempotencyKey);
        }
        catch (error) {
            if (error instanceof FiredrillError && error.details.uncertain)
                throw new FiredrillError(error.code, "The reassessment acknowledgement was not confirmed.", "Read assessment history and reconcile with the same key and unchanged input. Do not submit a new evaluator action or rerun the target.", error.details);
            throw error;
        }
    }
    report(runId, options = {}) {
        const query = activityReportQuery(options);
        const filters = { eventKind: query.get("eventKind") ?? undefined, eventProducer: query.get("eventProducer") ?? undefined };
        return this.request("GET", `/v1/runs/${id(runId)}/report?${query}`)
            .then(response => confirmActivitySelection(response, filters));
    }
    /** Bounded operator view with explicit references instead of large embedded values. */
    inspectReport(runId, options = {}) {
        const path = operatorReportPath(runId, options);
        const filters = { eventKind: options.eventKind, eventProducer: options.eventProducer };
        return this.readRetained(path).then(response => confirmActivitySelection(response, filters, true));
    }
    inspectBatch(batchId) {
        return this.readRetained(operatorBatchPath(batchId));
    }
    /** One chunk of a retained JSON value; never executes or automatically loads the rest. */
    readValue(runId, options) {
        return this.readRetained(retainedValuePath("run", runId, options));
    }
    readBatchValue(batchId, options = {}) {
        return this.readRetained(retainedValuePath("batch", batchId, options));
    }
    async readRetained(path) {
        try {
            return await this.request("GET", path);
        }
        catch (error) {
            if (error instanceof FiredrillError && error.code === "TRANSPORT_UNCERTAIN")
                throw new FiredrillError(error.code, "The retained read response could not be confirmed.", "Repeat the same read with the same source, pointer, offset and digest. This does not execute targets or request evaluation.", { ...error.details, uncertain: false });
            throw error;
        }
    }
    sequence(runId) { return this.request("GET", `/v1/runs/${id(runId)}/sequence`); }
    list(batchId, options = {}) {
        const query = new URLSearchParams();
        if (options.cursor)
            query.set("cursor", options.cursor);
        if (options.limit)
            query.set("limit", String(options.limit));
        const { cursor: _cursor, limit: _limit, ...selected } = options;
        for (const [key, value] of Object.entries(inspectionFilterQuery(checkedInspectionFilters(selected))))
            query.set(key, value);
        return this.request("GET", `/v1/batches/${id(batchId)}/runs?${query}`);
    }
    /** Follow result.pagination.nextCursor without loading all outputs into memory. */
    listRuns(batchId, options = {}) { return this.list(batchId, options); }
    async cancel(batchId, idempotencyKey = `cancel:${batchId}`) {
        const scope = this.scope();
        const batch = await this.request("POST", `/v1/batches/${id(batchId)}/cancel`, scope, idempotencyKey);
        if (!batch || batch.id !== batchId || batch.projectId !== scope.projectId || batch.environmentId !== scope.environmentId)
            throw new FiredrillError("CANCELLATION_SCOPE_UNCONFIRMED", "The cancellation response does not confirm the selected batch and project/environment.", "Inspect the exact batch with its original scope and reuse the same cancellation key. Do not interpret this response as a confirmed stop.", { uncertain: true, batchId });
        return batch;
    }
    async resume(operationId, target, options = {}) {
        const store = new JournalStore(this.options.journalDirectory), unlock = store.lock(operationId);
        let journal;
        try {
            journal = store.read(operationId);
            if ("purpose" in journal && journal.purpose === "submission-only")
                throw new FiredrillError("SUBMISSION_NOT_EXECUTION", "A submission-only intent cannot become an execution journal.", "Use resumeSubmission with its original submission key to reconcile creation, then explicitly attach a new customer runner with run(batchId).");
            const scope = this.scope();
            if (journal.apiUrl !== this.apiUrl || journal.projectId !== scope.projectId || journal.environmentId !== scope.environmentId)
                throw new FiredrillError("RECOVERY_SCOPE_CONFLICT", "Recovery belongs to a different API origin or project/environment.", "Use the original identity, API origin, project/environment and private journal directory.", { operationId });
            matchRetainedSubmission(journal.submission, options);
            if (journal.phase === "done") {
                if (!journal.batchId)
                    throw new FiredrillError("JOURNAL_UNSAFE", "The completed journal has no retained batch identity.", "Preserve the original journal for inspection; do not create replacement work.", { operationId });
                // Completed recovery is a retained read, not another execution. In
                // particular, native closures and isolated adapters are not needed.
                const result = await this.result(journal.batchId);
                if (result.batch.id !== journal.batchId || result.batch.projectId !== scope.projectId || result.batch.environmentId !== scope.environmentId)
                    throw new FiredrillError("BATCH_SCOPE_CONFLICT", "The retained result does not match the original recovery scope.", "Preserve the journal and inspect the exact batch with its original identity; no target was invoked.", { operationId, batchId: journal.batchId });
                return simulationResult(result, operationId, journal.submission?.ci);
            }
        }
        catch (error) {
            if (error instanceof FiredrillError)
                throw new FiredrillError(error.code, error.message, error.repair, { ...error.details, operationId });
            throw error;
        }
        finally {
            unlock();
        }
        try {
            return await this.simulate(journal.recipe, target, { ...options, resume: operationId });
        }
        catch (error) {
            if (error instanceof FiredrillError)
                throw new FiredrillError(error.code, error.message, error.repair, { ...error.details, operationId, batchId: journal.batchId });
            throw error;
        }
    }
    async simulate(input, target, options = {}) {
        const value = typeof input === "string" ? readJsonInput(input, 8 * 1024 * 1024, "RECIPE_INVALID") : input;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            const parsed = RecipeSchema.safeParse(value);
            if (!parsed.success)
                throw definitionError("RECIPE_INVALID", "Recipe validation failed.", "Supply a saved JSON object or inline recipe. No simulation was started.", parsed.error.issues);
        }
        return this.execute(value, target, options);
    }
    /** Queue only. A later customer runner supplies its callback/adapter and executes. */
    submit(input, options) {
        return submitBatch({ ...this.scope(), apiUrl: this.apiUrl, journalDirectory: this.options.journalDirectory,
            request: (method, path, body, key) => this.request(method, path, body, key) }, input, options);
    }
    resumeSubmission(submissionKey, options = {}) {
        return resumeBatchSubmission({ ...this.scope(), apiUrl: this.apiUrl, journalDirectory: this.options.journalDirectory,
            request: (method, path, body, key) => this.request(method, path, body, key) }, submissionKey, options);
    }
    async run(batchId, target, options = {}) {
        const scope = this.scope(), batch = await this.status(batchId);
        if (batch.id !== batchId || batch.projectId !== scope.projectId || batch.environmentId !== scope.environmentId)
            throw new FiredrillError("BATCH_SCOPE_CONFLICT", "The retained batch is not in the selected project/environment.", "Select the exact batch scope before attaching its customer runner.");
        return this.execute(batch.recipe, target, options, batch);
    }
    async execute(input, target, options, existingBatch) {
        const scope = this.scope();
        for (const [name, value, minimum] of [["followTimeoutMs", options.followTimeoutMs, 1], ["assessmentTimeoutMs", options.assessmentTimeoutMs, 0]]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > 86400000))
                throw new FiredrillError("WAIT_BOUND_INVALID", `${name} must be an integer between ${minimum} and 86400000.`, "Supply a bounded observation period.");
        }
        if (options.allowParallel !== undefined && typeof options.allowParallel !== "boolean")
            throw new FiredrillError("TARGET_EXECUTION_INVALID", "allowParallel must be an explicit boolean.", "Use a retained targetExecution declaration, or pass allowParallel: true only when creating a new simulation after reviewing its shared-state boundary.");
        const selectedTarget = input.target ?? (target ? { kind: "native", name: target.name || "callback" } : undefined);
        const freshAcknowledgement = !options.resume && !existingBatch && options.allowParallel === true && selectedTarget?.kind !== "isolated_node" && input.targetExecution === undefined
            ? { targetExecution: { schemaVersion: TARGET_EXECUTION_VERSION, nonHermeticParallel: "acknowledged" } } : {};
        const parsed = RecipeSchema.safeParse({ schemaVersion: CONTRACT_VERSION, ...input, target: selectedTarget, ...freshAcknowledgement });
        if (!parsed.success)
            throw definitionError("RECIPE_INVALID", "Recipe validation failed.", "Correct the listed fields before execution. No simulation was started.", parsed.error.issues);
        const recipe = parsed.data;
        const submission = options.resume || existingBatch ? undefined : newSubmission(options);
        if (existingBatch)
            matchRetainedSubmission(existingBatch.submission, options);
        if (recipe.target.kind === "native" && !target)
            throw new FiredrillError("NATIVE_TARGET_REQUIRED", "The recipe needs its native callback in this process.", "Pass simulate(recipe, callback), or use an importable command target.");
        if (recipe.target.kind !== "native" && target)
            throw new FiredrillError("TARGET_CONFLICT", "A callback cannot replace an explicit target binding.", "Choose exactly one target binding.");
        const isolated = this.options.isolated ? { ...this.options.isolated, apiUrl: this.apiUrl } : undefined;
        if (recipe.target.kind === "isolated_node" && (!isolated || typeof isolated.directory !== "string" || !isolated.adapter || ["runIsolated", "reconcileIsolated", "attachIsolatedEvidence"].some(key => typeof isolated.adapter[key] !== "function")))
            throw new FiredrillError("ISOLATED_RUNNER_REQUIRED", "An isolated target needs its explicitly prepared customer-local adapter and source directory.", "Pass isolated: { directory, adapter }. This client never installs an image or silently selects another execution boundary.");
        if (recipe.target.kind !== "isolated_node" && recipe.concurrency > 1 && recipe.targetExecution?.nonHermeticParallel !== "acknowledged")
            throw new FiredrillError("NON_HERMETIC_CONCURRENCY", "Parallel execution of this target has no retained non-hermetic acknowledgement.", "Use concurrency 1, or declare targetExecution in a new recipe after reviewing shared process, filesystem and remote application state. Fresh simulate may retain allowParallel: true; run/resume cannot change an existing recipe.");
        const store = new JournalStore(this.options.journalDirectory);
        const operationId = options.resume ?? randomUUID();
        const unlock = store.lock(operationId);
        let journal;
        try {
            // The last owner may have written a running marker immediately before it
            // exited. Never execute a pre-lock snapshot after reclaiming its stale lock.
            journal = options.resume ? store.read(options.resume) : { version: 1, id: operationId, apiUrl: this.apiUrl, ...scope, recipe, ...(existingBatch ? existingBatch.submission ? { submission: existingBatch.submission } : {} : submission ? { submission } : {}), phase: existingBatch ? "active" : "create", ...(existingBatch ? { batchId: existingBatch.id } : { admissionDispatched: false }), createKey: randomUUID(), runnerId: randomUUID(), work: [], createdAt: new Date().toISOString() };
            if ("purpose" in journal && journal.purpose === "submission-only")
                throw new FiredrillError("SUBMISSION_NOT_EXECUTION", "A submission-only intent cannot become an execution journal.", "Use resumeSubmission with its submission key; target execution requires a deliberate run(batchId) with its own runner state.");
            if (journal.apiUrl !== this.apiUrl || journal.projectId !== scope.projectId || journal.environmentId !== scope.environmentId || JSON.stringify(journal.recipe) !== JSON.stringify(recipe) || existingBatch && journal.batchId !== existingBatch.id)
                throw new FiredrillError("RECOVERY_SCOPE_CONFLICT", "Recovery belongs to a different origin, scope, recipe or batch.", "Resume with the original scope and unchanged recipe.");
            if (options.resume || existingBatch)
                matchRetainedSubmission(journal.submission, options);
        }
        catch (error) {
            unlock();
            throw error;
        }
        const save = () => store.save(journal);
        const attachments = (work) => attachmentCoordinator(work, save, {
            declare: (path, body, key) => this.request("POST", path, body, key),
            upload: (path, content, mediaType, attemptId, leaseToken) => this.uploadArtifact(path, content, mediaType, attemptId, leaseToken),
        });
        const notify = (phase, runId, preexecution, runnerCapacity) => {
            // Progress is advisory. A presentation callback must not interrupt an
            // admitted execution, suppress its retained result or change recovery.
            try {
                if (!options.onProgress && preexecution) {
                    const numbers = (source, keys) => Object.fromEntries(keys.map(key => {
                        const value = source[key];
                        return [key, typeof value === "number" && Number.isFinite(value) ? value : null];
                    }));
                    process.stderr.write(`${JSON.stringify({ progress: { operationId: journal.id, ...(journal.batchId ? { batchId: journal.batchId } : {}), phase,
                            preexecutionSummary: { ...scope,
                                expansion: numbers(preexecution.expansion, ["scenarios", "configurations", "repetitions", "runs", "maximumTargetInvocations"]),
                                limits: numbers(preexecution.limits, ["maxActiveRuns", "pendingRunsPerOrganization", "pendingRunsGlobal", "recipeBytes", "expandedBatchBytes", "invocationTimeoutMs", "maxOutputBytes", "maxRuns"]),
                                estimates: numbers(preexecution.estimates, ["expandedInputBytes", "maximumConcurrentRuns", "totalServiceInstances", "maximumConcurrentServiceInstances"]),
                                assessmentPolicy: preexecution.assessment.policy === undefined ? "unknown" : preexecution.assessment.policy === null ? null
                                    : numbers(preexecution.assessment.policy, ["maxRequestsPerBatch", "maxConcurrentRequests", "maxInputBytes", "maxOutputTokens", "maxAttemptsPerAssessment"]),
                                targetIsolation: ["customer_process", "remote_application", "customer_isolated_runner"].includes(preexecution.target.isolation) ? preexecution.target.isolation : "unknown",
                                admissionState: ["currently_admissible", "blocked"].includes(preexecution.admission.state) ? preexecution.admission.state : "unknown",
                                customerInferenceAndRunnerCosts: "separate_and_unknown",
                                estimate: phase === "preexecution_retained" ? "saved_not_current_admission" : "non_reserving" } } })}\n`);
                }
                if (!options.onProgress && runnerCapacity)
                    process.stderr.write(`${JSON.stringify({ progress: { operationId: journal.id, batchId: journal.batchId, phase, runnerCapacity } })}\n`);
                const notification = options.onProgress?.({ operationId: journal.id, batchId: journal.batchId, phase, runId, ...(preexecution ? { preexecution: JSON.parse(JSON.stringify(preexecution)) } : {}), ...(runnerCapacity ? { runnerCapacity: { ...runnerCapacity } } : {}) });
                if (notification)
                    void Promise.resolve(notification).catch(() => { });
            }
            catch { /* The durable journal and returned result remain authoritative. */ }
        };
        const deadline = Date.now() + (options.followTimeoutMs ?? 30 * 60 * 1000);
        const stopping = new AbortController();
        let cancelRequest;
        const cancel = () => { stopping.abort(new Error("CANCELLED: caller requested cancellation")); if (journal.batchId)
            cancelRequest = this.cancel(journal.batchId); cancelRequest?.catch(() => { }); };
        options.signal?.addEventListener("abort", cancel, { once: true });
        try {
            save();
            notify("prepared");
            if (options.signal?.aborted)
                cancel();
            if (journal.phase === "create") {
                if (stopping.signal.aborted)
                    throw new FiredrillError("CANCELLED", "Simulation cancelled before creation.", "No target was invoked.");
                // Only fresh execution prepares a new estimate. An uncertain admission
                // must reconcile its original create key even if capacity later changes.
                if (!options.resume || journal.admissionDispatched === false && !journal.preexecution) {
                    journal.preexecution = await this.preview(recipe);
                    save();
                    notify("preexecution", undefined, journal.preexecution);
                }
                else if (journal.preexecution)
                    notify("preexecution_retained", undefined, journal.preexecution);
                if (stopping.signal.aborted)
                    throw new FiredrillError("CANCELLED", "Simulation cancelled before admission.", "No target was invoked; preserve the saved operation if resuming.");
                journal.admissionDispatched = true;
                save();
                const batch = await this.request("POST", "/v1/batches", { ...scope, recipe, ...(journal.submission ? { submission: journal.submission } : {}) }, journal.createKey);
                journal.batchId = batch.id;
                journal.phase = "active";
                save();
                notify("admitted");
                if (options.signal?.aborted)
                    cancel();
            }
            const batchId = journal.batchId;
            const pinIsolated = (work, path, claim, step) => {
                work.isolatedReceipt = { path, input: claim.run.scenario.input, timeoutMs: claim.limits.timeoutMs, maxOutputBytes: claim.limits.maxOutputBytes, ...(step ? { step } : {}) };
                save(); // Awaited by the adapter before any child or resource is started.
            };
            const retainOutcome = (work, outcome) => {
                JsonSchema.parse(outcome.output);
                if (outcome.stopUnconfirmed) {
                    work.stopUnconfirmed = true;
                    stopping.abort(new Error("TARGET_STOP_UNCONFIRMED"));
                }
                work.events = outcome.events;
                work.finish = { attemptId: work.claim.attemptId, leaseToken: work.claim.leaseToken, execution: outcome.execution, output: outcome.output, reason: outcome.reason?.slice(0, 4000) ?? null, metrics: outcome.metrics };
                work.finishKey = randomUUID();
                work.phase = "events";
                if (work.isolatedReceipt)
                    work.isolatedReceipt.settled = true;
                save();
                notify("finalizing", work.claim.run.id);
            };
            const recoverIsolated = async (work) => {
                const receipt = work.isolatedReceipt;
                if (!receipt || receipt.settled)
                    return;
                if (!isolated || !work.claim || work.claim.run.target.kind !== "isolated_node" ||
                    receipt.step && (work.phase !== "sequence" || work.sequenceStep?.phase !== "running" || work.sequenceStep.ordinal !== receipt.step.ordinal || work.sequenceStep.stepId !== receipt.step.id))
                    throw new FiredrillError("ISOLATED_RECOVERY_SCOPE_MISMATCH", "The isolated receipt does not match this retained execution phase.", "Preserve the journal and receipt. Do not invoke the target again.");
                const claim = { ...work.claim, run: { ...work.claim.run, scenario: { ...work.claim.run.scenario, input: receipt.input } },
                    limits: { ...work.claim.limits, timeoutMs: receipt.timeoutMs, maxOutputBytes: receipt.maxOutputBytes } };
                // Always reconcile the exact local descendants first—even a terminal
                // control record cannot prove that a customer-local container stopped.
                const outcome = await reconcileIsolatedExecution(claim, receipt.path, attachments(work).attach, {}, isolated, receipt.step);
                const retained = await this.request("GET", `/v1/runs/${id(claim.run.id)}`);
                receipt.settled = true;
                if (terminal(retained)) {
                    work.phase = "done";
                    work.claim.leaseToken = "";
                    save();
                    return;
                }
                if (receipt.step) {
                    work.sequenceStep = { ordinal: receipt.step.ordinal, stepId: receipt.step.id, phase: "complete",
                        completion: { ordinal: receipt.step.ordinal, execution: outcome.execution, output: outcome.output, reason: outcome.reason, metrics: outcome.metrics },
                        events: outcome.events.map(item => ({ ...item, payload: { stepId: receipt.step.id, ordinal: receipt.step.ordinal, observation: item.payload } })) };
                    save();
                }
                else
                    retainOutcome(work, outcome);
            };
            const finishWork = async (work) => {
                await recoverIsolated(work);
                if (work.phase === "done")
                    return;
                // Attachment recovery never invokes target code, and pending bytes prevent finish.
                await attachments(work).reconcile();
                if (work.phase === "running") {
                    const run = await this.request("GET", `/v1/runs/${id(work.claim.run.id)}`);
                    if (terminal(run)) {
                        work.phase = "done";
                        save();
                        return;
                    }
                    await flushLiveEvents(work, save, events => this.request("POST", `/v1/runs/${id(work.claim.run.id)}/events`, { attemptId: work.claim.attemptId, leaseToken: work.claim.leaseToken, events }));
                    throw new FiredrillError("EXECUTION_UNCERTAIN", "This target may already have executed; it will not be invoked again.", "Inspect the retained run. Reconcile its actual outcome or wait for lease interruption before starting explicitly new work.", { operationId: journal.id, batchId, uncertain: true });
                }
                if (work.phase === "events") {
                    for (let offset = 0; offset < work.events.length; offset += 16)
                        await this.request("POST", `/v1/runs/${id(work.claim.run.id)}/events`, { attemptId: work.claim.attemptId, leaseToken: work.claim.leaseToken, events: work.events.slice(offset, offset + 16) });
                    delete work.liveEvents;
                    work.phase = "finish";
                    save();
                }
                if (work.phase === "finish") {
                    await this.request("POST", `/v1/runs/${id(work.claim.run.id)}/finish`, work.finish, work.finishKey);
                    work.phase = "done";
                    delete work.events;
                    delete work.finish;
                    if (work.claim)
                        work.claim.leaseToken = "";
                    save();
                    notify("retained", work.claim?.run.id);
                }
            };
            // Reconcile existing work first. A retained running marker never invokes a callback.
            for (const work of journal.work) {
                if (["command", "http", "native"].includes(work.claim?.run.target.kind ?? "") && (work.phase === "running"
                    || work.phase === "sequence" && work.sequenceStep?.phase === "running")) {
                    // A terminal server lease cannot prove customer-owned work launched
                    // by a lost native/command/HTTP coordinator stopped. Fence before reads;
                    // never signal a recycled PID or dispatch a replacement HTTP request.
                    work.stopUnconfirmed = true;
                    stopping.abort(new Error("TARGET_STOP_UNCONFIRMED"));
                    save();
                }
                await recoverIsolated(work);
                if (work.phase === "sequence" && work.sequenceStep?.phase === "complete" && work.sequenceStep.stopUnconfirmed) {
                    stopping.abort(new Error("TARGET_STOP_UNCONFIRMED"));
                    await attachments(work).reconcile();
                    const outcome = await executeSequence({ work, save, target, signal: stopping.signal, attach: attachments(work).attach,
                        request: (path, body) => this.request("POST", path, body),
                        tools: async () => { throw new FiredrillError("TARGET_STOP_UNCONFIRMED", "An interrupted target sequence cannot prepare further target work.", "Inspect the customer execution host; this recovery only retains the already-completed step."); } });
                    retainOutcome(work, outcome);
                }
                if (work.phase !== "claim" && work.phase !== "sequence")
                    await finishWork(work);
            }
            if (journal.work.some(work => work.stopUnconfirmed))
                stopping.abort(new Error("TARGET_STOP_UNCONFIRMED"));
            const execute = async (work) => {
                // Expiring observation stops new dispatch; it is not a cancellation or
                // target failure. Leave exact pending claim/sequence intent for resume.
                if (Date.now() >= deadline)
                    return true;
                if (work.claim) {
                    const retained = await this.request("GET", `/v1/runs/${id(work.claim.run.id)}`);
                    if (terminal(retained)) {
                        work.phase = "done";
                        work.claim.leaseToken = "";
                        save();
                        return true;
                    }
                }
                const response = await this.request("POST", `/v1/batches/${id(batchId)}/claim`, { runnerId: journal.runnerId }, work.key);
                if (!response.claim) {
                    work.phase = "done";
                    save();
                    return false;
                }
                if (response.claim.run.batchId !== batchId || response.claim.run.projectId !== scope.projectId || response.claim.run.environmentId !== scope.environmentId || response.claim.attemptId !== response.claim.run.attemptId)
                    throw new FiredrillError("CLAIM_SCOPE_MISMATCH", "The claimed invocation does not match this exact batch and scope.", "Preserve the recovery journal and inspect the control response; no target was invoked.");
                // A claimed/preparing marker may reconcile setup; a running marker never
                // reinvokes the target after a crash or unknown response.
                work.claim = response.claim;
                save();
                notify("preparing", response.claim.run.id);
                if (Date.now() >= deadline)
                    return true;
                const controller = new AbortController();
                const stop = () => controller.abort(stopping.signal.reason);
                stopping.signal.addEventListener("abort", stop, { once: true });
                if (stopping.signal.aborted)
                    stop();
                let heartbeat;
                const beat = () => {
                    if (heartbeat)
                        return;
                    heartbeat = this.request("POST", `/v1/runs/${id(response.claim.run.id)}/heartbeat`, { attemptId: response.claim.attemptId, leaseToken: response.claim.leaseToken }).then(reply => { if (reply.cancellationRequested)
                        controller.abort(new Error("CANCELLED: service requested cancellation")); }).catch(() => { controller.abort(new Error("LEASE_UNCONFIRMED: heartbeat could not confirm execution authority")); }).finally(() => { heartbeat = undefined; });
                };
                const interval = setInterval(beat, 15000);
                try {
                    // Replayed claims must still have current authority before any target starts.
                    const initial = await this.request("POST", `/v1/runs/${id(response.claim.run.id)}/heartbeat`, { attemptId: response.claim.attemptId, leaseToken: response.claim.leaseToken });
                    if (initial.cancellationRequested)
                        controller.abort(new Error("CANCELLED: service requested cancellation"));
                    let tools = {}, preparationFailure;
                    if (recipe.services.length && controller.signal.aborted)
                        throw new FiredrillError("PREPARATION_INTERRUPTED", "Tool preparation stopped before target invocation.", "Inspect or resume the retained operation; cancellation or lost authority does not start the target.");
                    if (recipe.services.length && !controller.signal.aborted) {
                        try {
                            const bindings = await this.request("POST", `/v1/runs/${id(response.claim.run.id)}/services`, { attemptId: response.claim.attemptId, leaseToken: response.claim.leaseToken });
                            tools = prepareRunTools(bindings, recipe.services, response.claim, this.apiUrl);
                        }
                        catch (error) {
                            const status = error instanceof FiredrillError ? Number(error.details.status) : 0;
                            if (!(error instanceof FiredrillError) || ![400, 404, 413, 422, 429].includes(status))
                                throw error;
                            preparationFailure = { execution: "interrupted", output: null, metrics: {}, reason: `Tool preparation rejected (${error.code}); target not invoked.`, events: [event("runner.preparation_failed", { code: error.code, targetInvoked: false })] };
                        }
                    }
                    let outcome;
                    if (!preparationFailure && Date.now() >= deadline)
                        return true;
                    if (preparationFailure)
                        outcome = preparationFailure;
                    else if (response.claim.run.scenario.sequence) {
                        work.phase = "sequence";
                        save();
                        notify("running", response.claim.run.id);
                        outcome = await executeSequence({ work, save, target, signal: controller.signal, attach: attachments(work).attach,
                            onStopUnconfirmed: () => stopping.abort(new Error("TARGET_STOP_UNCONFIRMED")),
                            ...(isolated ? { isolated: { binding: isolated, onPrepared: (path, claim, step) => pinIsolated(work, path, claim, step) } } : {}),
                            request: (path, body) => this.request("POST", path, body), tools: async () => {
                                if (!recipe.services.length)
                                    return {};
                                const bindings = await this.request("POST", `/v1/runs/${id(response.claim.run.id)}/services`, { attemptId: response.claim.attemptId, leaseToken: response.claim.leaseToken });
                                return prepareRunTools(bindings, recipe.services, response.claim, this.apiUrl);
                            } });
                    }
                    else {
                        // Save immediately before execution, never while waiting for setup.
                        work.phase = "running";
                        save();
                        notify("running", response.claim.run.id);
                        const stream = recipe.target.kind === "native" ? liveEvents(work, save, events => this.request("POST", `/v1/runs/${id(response.claim.run.id)}/events`, { attemptId: response.claim.attemptId, leaseToken: response.claim.leaseToken, events })) : undefined;
                        try {
                            outcome = redactToolSecrets(await executeTarget(response.claim, target, controller.signal, attachments(work).attach, tools, undefined, isolated ? { binding: isolated, onPrepared: path => pinIsolated(work, path, response.claim) } : undefined, stream ? item => stream.record(redactToolSecrets(item, tools)) : undefined), tools);
                            if (outcome.stopUnconfirmed) {
                                work.stopUnconfirmed = true;
                                stopping.abort(new Error("TARGET_STOP_UNCONFIRMED"));
                                save(); // Evidence settlement cannot erase the adapter's stop fence.
                            }
                        }
                        finally {
                            await stream?.settle();
                        }
                    }
                    if (outcome.execution === "interrupted" && recipe.target.kind === "native")
                        stopping.abort(new Error("TARGET_STOP_UNCONFIRMED"));
                    retainOutcome(work, outcome);
                    await finishWork(work);
                }
                finally {
                    clearInterval(interval);
                    await heartbeat;
                    stopping.signal.removeEventListener("abort", stop);
                }
                return true;
            };
            const pending = journal.work.filter(work => work.phase === "claim" || work.phase === "sequence");
            for (const work of pending) {
                if (stopping.signal.aborted || Date.now() >= deadline)
                    break;
                await execute(work);
            }
            const worker = async () => {
                try {
                    while (!stopping.signal.aborted) {
                        if (Date.now() >= deadline)
                            return;
                        const work = { key: randomUUID(), phase: "claim" };
                        journal.work.push(work);
                        save();
                        if (!await execute(work)) {
                            // A confirmed empty claim is safe to replace. Reuse this slot while capacity
                            // is unavailable; never retry the same idempotency key expecting new work.
                            while (!stopping.signal.aborted) {
                                if (Date.now() >= deadline)
                                    return;
                                const remaining = await this.status(batchId);
                                if (!remaining.counts.queued || remaining.cancellationRequested)
                                    return;
                                if (Date.now() >= deadline)
                                    return;
                                await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
                                if (stopping.signal.aborted || Date.now() >= deadline)
                                    return;
                                work.key = randomUUID();
                                work.phase = "claim";
                                delete work.claim;
                                save();
                                if (await execute(work))
                                    break;
                            }
                        }
                    }
                }
                catch (error) {
                    stopping.abort(new Error("COORDINATION_INTERRUPTED: inspect saved operation before more target work"));
                    throw error;
                }
            };
            // Requested concurrency is not a worker-allocation size or a customer
            // quota. Use the admitted batch's current physical execution envelope.
            // Older services without this disclosure can still recover serially.
            const dispatch = await this.status(batchId), slots = dispatch.operations?.resources.runSlotLimit;
            if (dispatch.id !== batchId || dispatch.projectId !== scope.projectId || dispatch.environmentId !== scope.environmentId
                || !Number.isSafeInteger(dispatch.total) || dispatch.total < 0
                || slots !== undefined && (!Number.isSafeInteger(slots) || slots < 0))
                throw new FiredrillError("BATCH_CAPACITY_INVALID", "The retained batch did not provide a valid execution envelope.", "Inspect the same batch and resume this saved operation; do not submit replacement work.");
            const localExecutionLimit = recipe.target.kind === "isolated_node" ? 2 : null;
            const workerCount = Math.min(recipe.concurrency, dispatch.total, slots ?? 1, localExecutionLimit ?? Number.MAX_SAFE_INTEGER);
            notify("runner_capacity", undefined, undefined, { requested: recipe.concurrency, workers: workerCount, serviceRunSlots: slots ?? null, admittedRuns: dispatch.total,
                localExecutionLimit, source: slots === undefined ? "older_service_serial_fallback" : "admitted_batch" });
            const outcomes = await Promise.allSettled(Array.from({ length: workerCount }, worker));
            const failed = outcomes.find((item) => item.status === "rejected");
            if (failed)
                throw failed.reason;
            if (cancelRequest)
                await cancelRequest;
            let batch = await this.status(batchId);
            while (batch.counts.running > 0 && !stopping.signal.aborted && Date.now() < deadline) {
                await delay(1000);
                batch = await this.status(batchId);
            }
            let result = await this.result(batchId);
            const assessmentDeadline = Date.now() + (options.assessmentTimeoutMs ?? 300000);
            const pendingAssessment = (value) => value.assessmentCounts ? (value.assessmentCounts.pending ?? 0) > 0 : value.runs.some(run => run.assessment === "pending");
            const executionTerminal = (value) => value.batch.counts.running === 0 && value.batch.counts.queued === 0;
            if (!executionTerminal(result) && Date.now() >= deadline)
                notify("follow_bound");
            if (executionTerminal(result) && pendingAssessment(result))
                notify("assessing");
            while (executionTerminal(result) && pendingAssessment(result) && !stopping.signal.aborted && Date.now() < assessmentDeadline) {
                await delay(Math.min(1000, Math.max(1, assessmentDeadline - Date.now())));
                result = await this.result(batchId);
            }
            if (executionTerminal(result)) {
                journal.phase = "done";
                save();
            }
            notify(journal.phase === "done" && !pendingAssessment(result) ? "complete" : "partial");
            return simulationResult(result, journal.id, journal.submission?.ci);
        }
        catch (error) {
            if (error instanceof FiredrillError)
                throw new FiredrillError(error.code, error.message, error.repair, { ...error.details, operationId: journal.id, batchId: journal.batchId,
                    workStarted: journal.admissionDispatched === false && !journal.batchId && !journal.work.some(work => work.claim !== undefined) ? false : "unknown",
                    retry: "reconcile" });
            throw new FiredrillError("SIMULATION_INTERRUPTED", "Simulation could not complete. Its exact recovery journal was retained.", "Resume using the operationId; do not create a new batch to recover this execution.", { operationId: journal.id, batchId: journal.batchId, uncertain: true, workStarted: "unknown", retry: "reconcile" });
        }
        finally {
            options.signal?.removeEventListener("abort", cancel);
            unlock();
        }
    }
}

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FiredrillError } from "./errors.js";
import { JournalStore } from "./journal.js";
import { readServiceBuildFailure } from "./service-build-diagnostics.js";
const invalid = (message) => { throw new FiredrillError("TOOL_START_INVALID", message, "Choose exact catalog release or saved build, unique aliases, explicit data and declared operations. Preserve any previously retained instances; recovery never replaces them."); };
const object = (value, allowed) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
        return invalid("Tool setup contains missing or unsupported fields.");
    return value;
};
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const observationVersion = "2026-10-16-tool-start-observation.1";
const authorizationCodes = new Set(["AUTH_REQUIRED", "AUTH_ACTION_REQUIRED", "FD_AUTH_REQUIRED", "FD_PERMISSION_DENIED", "FD_SCOPE_RESTRICTED",
    "FD_SDK_IDENTITY_CHANGED", "FD_MCP_IDENTITY_CHANGED", "FD_MCP_AUTH_UNCONFIRMED", "FD_LOGIN_REQUIRED", "FD_LOGIN_INACTIVE",
    "FD_LOGIN_ORGANIZATION_REQUIRED", "FD_LOGIN_ORGANIZATION_UNAVAILABLE", "FD_LOGIN_CONFIGURATION_CHANGED", "FD_LOGIN_LOGOUT_PENDING"]);
function authorizationFailure(error, key) {
    const responseStatus = error && typeof error === "object" && "responseStatus" in error ? error.responseStatus : undefined;
    const status = error instanceof FiredrillError && [401, 403].includes(error.details.status ?? 0) ? error.details.status : responseStatus;
    if (status !== 401 && status !== 403 && !(error instanceof FiredrillError && authorizationCodes.has(error.code)))
        return undefined;
    if (error instanceof FiredrillError)
        return new FiredrillError(error.code, error.message, error.repair, {
            ...error.details, ...(status === 401 || status === 403 ? { status } : {}), operationId: key,
        });
    return new FiredrillError(status === 401 ? "FD_AUTH_REQUIRED" : "FD_PERMISSION_DENIED", "Tool setup stopped because current authorization was rejected.", "Restore the original authorized identity and scope, then resume the same operation key and unchanged plan. Known resources were not replaced.", { operationId: key, ...(status === 401 || status === 403 ? { status } : {}) });
}
function unconfirmInstance(item) {
    delete item.access;
    if (!item.instance) {
        delete item.instanceObservation;
        return;
    }
    const previous = item.instanceObservation;
    item.instanceObservation = { schemaVersion: observationVersion, state: "unconfirmed",
        lastConfirmedAt: previous?.schemaVersion === observationVersion && typeof previous.lastConfirmedAt === "string" && Number.isFinite(Date.parse(previous.lastConfirmedAt)) ? previous.lastConfirmedAt : null };
}
function selectedInstance(value, scope, buildId, instanceId) {
    if (!value || typeof value !== "object" || !opaque(value.id) || instanceId !== undefined && value.id !== instanceId
        || value.projectId !== scope.projectId || value.environmentId !== scope.environmentId || value.buildId !== buildId)
        throw new FiredrillError("TOOL_START_INSTANCE_UNCONFIRMED", "The service did not confirm the selected instance identity, scope and build.", "Preserve the original plan/key and known instance. Reconcile that same intent; do not follow links or allocate a replacement from this unconfirmed response.", { uncertain: true });
    return value;
}
export function validateToolStartPlan(input) {
    const value = object(input, ["schemaVersion", "tools"]);
    try {
        if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
            invalid("Tool setup exceeds its 4 MiB serialized plan bound.");
    }
    catch (error) {
        if (error instanceof FiredrillError)
            throw error;
        invalid("Tool setup must be bounded JSON.");
    }
    if (value.schemaVersion !== undefined && value.schemaVersion !== "2026-10-15-tool-start.1" || !Array.isArray(value.tools) || !value.tools.length)
        invalid("Choose one or more named Tool instances.");
    const aliases = new Set();
    const tools = value.tools.map((raw) => {
        const tool = object(raw, ["alias", "source", "data", "operations", "seed", "ttlSeconds"]);
        if (typeof tool.alias !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool.alias) || aliases.has(tool.alias))
            invalid("Each instance needs a distinct lowercase alias, including repeated copies of the same Tool.");
        aliases.add(tool.alias);
        const source = object(tool.source, ["kind", "catalogId", "releaseDigest", "buildId"]);
        if (source.kind === "catalog") {
            if (Object.keys(source).length !== 3 || typeof source.catalogId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(source.catalogId) || typeof source.releaseDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.releaseDigest))
                invalid("Catalog selection requires its exact ID and releaseDigest.");
        }
        else if (source.kind !== "build" || Object.keys(source).length !== 2 || !opaque(source.buildId))
            invalid("Select an exact saved build or catalog release.");
        const data = object(tool.data, ["kind", "datasetId"]);
        if (data.kind === "saved") {
            if (Object.keys(data).length !== 2 || !opaque(data.datasetId) || source.kind !== "build")
                invalid("Saved datasets require their exact saved build. Select that build rather than a catalog acquisition.");
        }
        else if (!["empty", "starter"].includes(data.kind) || Object.keys(data).length !== 1 || data.kind === "starter" && source.kind !== "catalog")
            invalid("Choose empty state, catalog starter data, or a saved dataset for its exact build.");
        if (!Array.isArray(tool.operations) || !tool.operations.length || tool.operations.length > 256 || tool.operations.some((op) => typeof op !== "string" || !op || op.length > 160) || new Set(tool.operations).size !== tool.operations.length)
            invalid("Select distinct declared operation IDs for each Tool.");
        const seed = tool.seed ?? "0", ttlSeconds = tool.ttlSeconds ?? 1800;
        if (typeof seed !== "string" || !/^(0|[1-9][0-9]*)$/.test(seed) || seed.length > 80 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 604800)
            invalid("Seed must be an unsigned decimal string; lifetime must be 1–604800 seconds.");
        return { alias: tool.alias, source: { ...source }, data: { ...data }, operations: [...tool.operations], seed, ttlSeconds };
    });
    const plan = { schemaVersion: "2026-10-15-tool-start.1", tools };
    if (Buffer.byteLength(JSON.stringify(plan)) > 4 * 1024 * 1024)
        invalid("Tool setup with defaults exceeds its 4 MiB serialized plan bound.");
    return plan;
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
function operationKey(value) {
    const selected = value ?? randomUUID();
    if (typeof selected !== "string" || !selected.trim() || selected.length > 200 || /[\r\n\0]/.test(selected))
        invalid("The setup operation key must be a nonempty string of at most 200 characters.");
    return selected;
}
export function toolStartStepKey(key, alias, phase) { return `tools-${hash(`${key}\n${alias}\n${phase}`)}`; }
function storage(context, scope, key) {
    const store = new JournalStore(join(context.journalDirectory ?? join(homedir(), ".local", "state", "firedrill"), "tool-starts"));
    const digest = hash(`${context.apiUrl}\n${scope.projectId}\n${scope.environmentId}\n${key}`);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const path = join(store.directory, `${id}.json`);
    return { lock: () => store.lock(id), read: () => {
            if (!existsSync(path))
                return undefined;
            const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const info = fstatSync(fd);
                if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
                    throw new Error("unsafe");
                return JSON.parse(readFileSync(fd, "utf8"));
            }
            catch {
                throw new FiredrillError("TOOL_START_JOURNAL_UNSAFE", "The existing Tool setup journal is unsafe or invalid.", "Preserve it and choose a private owned recovery directory; do not allocate replacements.");
            }
            finally {
                closeSync(fd);
            }
        }, save: (state) => {
            const serialized = JSON.stringify(state);
            if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
                throw new FiredrillError("TOOL_START_JOURNAL_BOUND", "Tool setup receipts exceed the 4 MiB private journal bound.", "Preserve the last saved plan/key and inspect its exact service receipts before resuming; do not allocate replacements.", { uncertain: true, workStarted: "unknown", retry: "reconcile" });
            const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
            try {
                writeFileSync(fd, serialized);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            renameSync(temporary, path);
            const directory = openSync(store.directory, "r");
            try {
                fsyncSync(directory);
            }
            finally {
                closeSync(directory);
            }
        } };
}
/** Validate exact retained builds on recovery, not the catalog's newer release. */
async function preflight(services, tool, item, acquisition, maxTtlSeconds) {
    if (item.instance)
        return;
    if (tool.ttlSeconds > maxTtlSeconds)
        invalid(`The lifetime for ${tool.alias} exceeds this service's ${maxTtlSeconds}-second limit.`);
    let operations;
    if (acquisition && !item.buildId)
        return; // Pending/failed exact receipt is observed, never replaced.
    if (tool.source.kind === "catalog" && !item.buildId) {
        const release = await services.catalogRelease(tool.source.catalogId);
        if (release.releaseDigest !== tool.source.releaseDigest)
            invalid(`The pinned release for ${tool.alias} is no longer the selected catalog release.`);
        operations = release.operations.map(op => op.id);
    }
    else {
        const buildId = item.buildId ?? (tool.source.kind === "build" ? tool.source.buildId : undefined);
        const build = await services.build(buildId);
        if (build.status !== "ready") {
            const failure = readServiceBuildFailure(build.failure);
            if (failure)
                throw new FiredrillError("FD_SERVICE_BUILD_FAILED", `The saved build for ${tool.alias} failed compilation.`, "Inspect the retained diagnostics. Publish corrected source with a new key, then deliberately select that new build; this setup does not replace resources automatically.", { buildId, failure });
            invalid(`The saved build for ${tool.alias} is not ready.`);
        }
        const declared = build.manifest.operations;
        if (!Array.isArray(declared))
            return invalid(`The build for ${tool.alias} has no declared operations.`);
        operations = declared.map(op => typeof op === "object" && op !== null && !Array.isArray(op) ? String(op.id) : "");
        const datasetId = item.datasetId ?? (tool.data.kind === "saved" ? tool.data.datasetId : undefined);
        if (datasetId && (await services.dataset(datasetId)).buildId !== buildId)
            invalid(`The dataset for ${tool.alias} belongs to a different build.`);
    }
    if (tool.operations.some(op => !operations.includes(op)))
        invalid(`The operation selection for ${tool.alias} is not declared by its exact build/release.`);
}
/** Stateless coordination for remote operators: caller retains exact plan/key; all writes remain idempotent service operations. */
export async function executeToolStart(services, scope, apiUrl, input, options, retained, checkpoint = () => { }) {
    const plan = validateToolStartPlan(input), key = operationKey(options.operationKey), timeout = options.waitTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 300000)
        invalid("waitTimeoutMs must be between 0 and 300000.");
    const deadline = Date.now() + timeout;
    const items = retained ?? plan.tools.map(tool => ({ alias: tool.alias, phase: "pending" }));
    const update = (item) => {
        checkpoint(items);
        // Notifications cannot interrupt durable provisioning or hide its recovery key.
        try {
            options.onProgress?.(structuredClone(item));
        }
        catch { /* Progress is advisory; returned receipt is authoritative. */ }
    };
    // A saved ready receipt or idempotent create response is not a fresh observation.
    // Invalidate all retained access before any cloud request, including preflight.
    for (const item of items) {
        unconfirmInstance(item);
        if (item.instance)
            item.phase = "uncertain";
    }
    checkpoint(items);
    const recordFailure = (item, error, notify = true) => {
        unconfirmInstance(item);
        item.phase = item.instance || !(error instanceof FiredrillError) || error.details.uncertain ? "uncertain" : "failed";
        item.error = (error instanceof FiredrillError ? error : new FiredrillError("TOOL_START_UNCONFIRMED", "This setup step could not be confirmed.", "Resume the same saved operation key and unchanged plan; do not create a replacement setup.", { uncertain: true, retry: "reconcile" })).toJSON().error;
        if (notify)
            update(item);
        else
            checkpoint(items);
    };
    const acquisitions = new Map(), failures = new Map();
    // Read exact idempotency receipts first, including a previously lost acquire response.
    for (const tool of plan.tools) {
        const item = items.find(item => item.alias === tool.alias);
        if (tool.source.kind !== "catalog" || item.instance || item.buildId)
            continue;
        try {
            const acquisition = item.acquisitionId ? await services.acquisition(item.acquisitionId) : await services.acquisitionByKey(toolStartStepKey(key, tool.alias, "acquire"));
            if (acquisition.catalogId !== tool.source.catalogId || acquisition.releaseDigest !== tool.source.releaseDigest || acquisition.initialData !== (tool.data.kind === "starter" ? "starter" : "empty"))
                throw new FiredrillError("TOOL_START_RECOVERY_CONFLICT", "The saved acquisition belongs to different input.", "Retain the original plan and operation key; do not replace existing resources.");
            acquisitions.set(tool.alias, acquisition);
            item.acquisitionId = acquisition.id;
            if (acquisition.phase === "ready" && acquisition.buildId) {
                item.buildId = acquisition.buildId;
                if (acquisition.datasetId)
                    item.datasetId = acquisition.datasetId;
            }
            update(item);
        }
        catch (error) {
            const rejected = authorizationFailure(error, key);
            if (rejected) {
                recordFailure(item, rejected, false);
                throw rejected;
            }
            if (!(error instanceof FiredrillError && error.code === "FD_SERVICE_NOT_FOUND" && error.details.status === 404 && !item.acquisitionId))
                failures.set(tool.alias, error);
        }
    }
    const partial = items.some(item => item.phase !== "pending" || item.acquisitionId || item.buildId || item.instance);
    const policy = await services.policy().catch(error => { throw authorizationFailure(error, key) ?? error; });
    // Present this existing preflight read before mutations; do not add a policy
    // lookup ahead of exact acquisition recovery or silently reserve resources.
    try {
        options.onProgress?.({ ...structuredClone(items[0]), policy: structuredClone(policy) });
    }
    catch { /* Advisory only. */ }
    for (const tool of plan.tools) {
        if (failures.has(tool.alias))
            continue;
        const item = items.find(item => item.alias === tool.alias);
        try {
            await preflight(services, tool, item, acquisitions.get(tool.alias), policy.limits.maxTtlSeconds);
        }
        catch (error) {
            const rejected = authorizationFailure(error, key);
            if (rejected) {
                recordFailure(item, rejected, false);
                throw rejected;
            }
            failures.set(tool.alias, error);
        }
    }
    if (!partial && failures.size)
        throw failures.values().next().value;
    for (const tool of plan.tools) {
        const item = items.find(item => item.alias === tool.alias);
        try {
            if (failures.has(tool.alias))
                throw failures.get(tool.alias);
            if (item.instance) {
                const instanceId = item.instance.id;
                item.instance = selectedInstance(await services.get(instanceId), scope, item.buildId, instanceId);
            }
            else {
                if (tool.source.kind === "catalog" && !item.buildId) {
                    item.phase = "acquiring";
                    delete item.error;
                    update(item);
                    const acquisitionKey = toolStartStepKey(key, tool.alias, "acquire");
                    let acquisition = acquisitions.get(tool.alias);
                    if (!acquisition || !["ready", "failed", "uncertain"].includes(acquisition.phase))
                        acquisition = await services.acquire({ catalogId: tool.source.catalogId, releaseDigest: tool.source.releaseDigest, initialData: tool.data.kind === "starter" ? "starter" : "empty" }, acquisitionKey);
                    item.acquisitionId = acquisition.id;
                    update(item);
                    while (!["ready", "failed", "uncertain"].includes(acquisition.phase) && Date.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
                        acquisition = await services.acquisition(acquisition.id);
                    }
                    if (acquisition.phase !== "ready" || !acquisition.buildId) {
                        item.phase = acquisition.phase === "failed" ? "failed" : acquisition.phase === "uncertain" ? "uncertain" : "acquiring";
                        if (acquisition.error)
                            item.error = { code: acquisition.error.code, message: "Tool acquisition did not complete.", repair: acquisition.error.repair };
                        update(item);
                        continue;
                    }
                    item.buildId = acquisition.buildId;
                    if (acquisition.datasetId)
                        item.datasetId = acquisition.datasetId;
                }
                else if (tool.source.kind === "build") {
                    item.buildId = tool.source.buildId;
                    if (tool.data.kind === "saved")
                        item.datasetId = tool.data.datasetId;
                }
                item.phase = "creating";
                delete item.error;
                update(item);
                item.instance = selectedInstance(await services.create({ buildId: item.buildId, ...(item.datasetId ? { datasetId: item.datasetId } : {}), seed: tool.seed, actorOperations: tool.operations, ttlSeconds: tool.ttlSeconds }, toolStartStepKey(key, tool.alias, "create")), scope, item.buildId);
                unconfirmInstance(item);
                update(item);
                const instanceId = item.instance.id;
                item.instance = selectedInstance(await services.get(instanceId), scope, item.buildId, instanceId);
            }
            item.instanceObservation = { schemaVersion: observationVersion, state: "confirmed", lastConfirmedAt: new Date().toISOString() };
            item.phase = item.instance.status === "active" && Date.parse(item.instance.expiresAt) > Date.now() ? "ready" : "unavailable";
            delete item.access;
            if (item.phase === "ready") {
                const base = `${apiUrl}/v1/service-instances/${item.instance.id}`, query = new URLSearchParams(scope).toString();
                item.access = { semanticApi: `${base}/operations?${query}`, mcp: `${base}/mcp?${query}`, ...(item.instance.service?.httpRoutes.length ? { httpBase: `${base}/http` } : {}), uiAvailable: item.instance.service?.view.available === true, authentication: "explicit_scoped_connection_required" };
            }
            delete item.error;
            update(item);
        }
        catch (error) {
            const rejected = authorizationFailure(error, key);
            recordFailure(item, rejected ?? error, !rejected);
            if (rejected)
                throw rejected;
        }
    }
    // Another selection can take longer than an earlier instance's remaining TTL.
    for (const item of items)
        if (item.phase === "ready" && !(Date.parse(item.instance.expiresAt) > Date.now())) {
            item.phase = "unavailable";
            delete item.access;
            update(item);
        }
    return { schemaVersion: "2026-10-15-tool-start.1", ...scope, operationKey: key, status: items.every(item => item.phase === "ready") ? "ready" : "partial", items, targetStarted: false, policy,
        recovery: "Resume this operationKey with its unchanged plan. Instance metadata is a last-observed snapshot; only a fresh GET confirms it for this attempt. Unconfirmed or inactive instances have no access hints. Known instances are never silently replaced. Connection credentials require explicit creation and private delivery." };
}
export async function startTools(services, scope, context, input, options = {}) {
    const plan = validateToolStartPlan(input), key = operationKey(options.operationKey);
    if (!context)
        throw new FiredrillError("TOOL_START_CONTEXT_REQUIRED", "Use client.services.start from an authenticated scoped Firedrill client.", "This helper needs the exact API origin and protected recovery storage.");
    let unlock;
    try {
        const identity = await context.identity(), journal = storage(context, scope, key);
        unlock = journal.lock();
        const prior = journal.read();
        if (prior && (prior.schemaVersion !== plan.schemaVersion || prior.operationKey !== key || prior.apiUrl !== context.apiUrl || JSON.stringify(prior.scope) !== JSON.stringify(scope) || JSON.stringify(prior.plan) !== JSON.stringify(plan) || prior.identity.id !== identity.id || prior.identity.organizationId !== identity.organizationId))
            throw new FiredrillError("TOOL_START_RECOVERY_CONFLICT", "The existing setup belongs to a different plan, scope or identity.", "Resume with the original identity and unchanged plan/key. No new Tool was started.");
        const state = prior ?? { schemaVersion: plan.schemaVersion, operationKey: key, apiUrl: context.apiUrl, scope, identity, plan, items: plan.tools.map(tool => ({ alias: tool.alias, phase: "pending" })) };
        journal.save(state);
        return await executeToolStart(services, scope, context.apiUrl, plan, { ...options, operationKey: key }, state.items, items => { state.items = items; journal.save(state); });
    }
    catch (error) {
        const rejected = authorizationFailure(error, key);
        if (rejected)
            throw rejected;
        if (error instanceof FiredrillError)
            throw new FiredrillError(error.code, error.message, error.repair, { ...error.details, operationId: key });
        throw new FiredrillError("TOOL_START_RECOVERY_REQUIRED", "Tool setup could not finish recording its result.", "Resume the same operation key and unchanged plan in the original private state directory. Previously allocated resources may exist; do not start replacements.", { operationId: key, uncertain: true });
    }
    finally {
        unlock?.();
    }
}
export async function resumeTools(services, scope, context, key, options = {}) {
    operationKey(key);
    if (!context)
        throw new FiredrillError("TOOL_START_CONTEXT_REQUIRED", "Use an authenticated scoped client.", "Resume with the original API, identity, project and environment.");
    const prior = storage(context, scope, key).read();
    if (!prior)
        throw new FiredrillError("TOOL_START_NOT_FOUND", "No saved setup was found for that key in this scope.", "Use the original private state directory, or supply the exact original plan and operationKey.");
    return startTools(services, scope, context, prior.plan, { ...options, operationKey: key });
}

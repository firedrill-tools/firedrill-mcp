import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { JsonSchema, TARGET_INVOCATION_VERSION, targetScenario } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
import { event } from "./targets.js";
import { redactToolSecrets } from "./run-tools.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const fail = (code, message, receiptPath, uncertain = false) => new FiredrillError(code, message, "Preserve this operation and its exact local receipt. Reconcile cleanup and original evidence only; do not re-invoke an uncertain target or silently switch runners.", { ...(receiptPath ? { receiptPath } : {}), uncertain });
function declaration(claim) {
    const target = claim.run.target;
    if (!target || target.kind !== "isolated_node" || !/^sha256:[a-f0-9]{64}$/.test(target.image) || !Array.isArray(target.files) || !target.files.length || target.files.length > 64)
        throw fail("ISOLATED_MANIFEST_INVALID", "An isolated target requires an exact image and selected-source manifest.");
    let bytes = 0;
    const names = new Set();
    for (const file of target.files) {
        if (!/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,159}$/.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) || names.has(file.path) ||
            !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256))
            throw fail("ISOLATED_MANIFEST_INVALID", "Selected files require unique safe paths, exact bounded sizes and SHA-256 digests.");
        bytes += file.bytes;
        names.add(file.path);
    }
    if (bytes > 8 * 1024 * 1024 || !names.has(target.entrypoint) || !/\.(?:js|mjs)$/.test(target.entrypoint))
        throw fail("ISOLATED_MANIFEST_INVALID", "Select at most 8 MiB of source and a declared .js/.mjs entrypoint.");
    if (!Number.isSafeInteger(claim.limits.timeoutMs) || claim.limits.timeoutMs < 1 || claim.limits.timeoutMs > 120000 || claim.limits.maxOutputBytes < 128 || claim.limits.maxOutputBytes > 4 * 1024 * 1024)
        throw fail("ISOLATED_LIMIT_UNSUPPORTED", "This isolated runner supports at most 120 seconds and 4 MiB combined output per invocation.");
    return target;
}
function bindingReady(binding) {
    if (!binding || typeof binding.directory !== "string" || !binding.adapter || ["runIsolated", "reconcileIsolated", "attachIsolatedEvidence"].some(key => typeof binding.adapter[key] !== "function"))
        throw fail("ISOLATED_RUNNER_REQUIRED", "Supply a customer-local directory and prepared isolated adapter; no native fallback or image installation is performed.");
}
function sourceFiles(target, directory) {
    const root = resolve(directory);
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
        throw fail("ISOLATED_SOURCE_UNSAFE", "The selected source directory must be a real directory without symlink ancestors.");
    return target.files.map(file => {
        const parts = file.path.split("/");
        let parent = root;
        for (const part of parts.slice(0, -1)) {
            parent = join(parent, part);
            const stat = lstatSync(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw fail("ISOLATED_SOURCE_UNSAFE", "Selected source parents cannot be symlinks.");
        }
        const fd = openSync(join(parent, parts.at(-1)), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes)
                throw fail("ISOLATED_SOURCE_CHANGED", "A selected file is not the pinned regular file size.");
            const bytes = Buffer.alloc(file.bytes);
            let read = 0;
            while (read < bytes.length) {
                const count = readSync(fd, bytes, read, bytes.length - read, read);
                if (!count)
                    break;
                read += count;
            }
            const extra = Buffer.alloc(1);
            if (read !== bytes.length || readSync(fd, extra, 0, 1, read) !== 0 || hash(bytes) !== file.sha256)
                throw fail("ISOLATED_SOURCE_CHANGED", "Selected source differs from its admitted size or digest; no target was invoked.");
            return { path: file.path, bytes };
        }
        finally {
            closeSync(fd);
        }
    });
}
function privateJson(path, maximum = 16 * 1024 * 1024) {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path))
        throw fail("ISOLATED_RECEIPT_UNSAFE", "The adapter receipt requires an absolute private path without symlink ancestors.", path);
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.mode & 0o077 || process.getuid && parent.uid !== process.getuid())
        throw fail("ISOLATED_RECEIPT_UNSAFE", "The adapter receipt directory is not private and current-user owned.", path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid())
            throw fail("ISOLATED_RECEIPT_UNSAFE", "The adapter receipt is not a bounded private regular file.", path);
        return JSON.parse(readFileSync(fd, "utf8"));
    }
    finally {
        closeSync(fd);
    }
}
function receiptAt(path, target) {
    const value = privateJson(path);
    if (basename(path) !== "receipt.json" || value.version !== 1 || value.receiptPath !== path || !/^fd-isolated-[a-f0-9-]{36}$/.test(value.id) || value.image !== target.image || value.entrypoint !== target.entrypoint || canonical(value.source) !== canonical(target.files))
        throw fail("ISOLATED_RECEIPT_MISMATCH", "The retained isolation receipt does not match this exact image and selected source.", path, true);
    return value;
}
function sealFor(claim, target, receipt, step) {
    return { version: 1, receiptId: receipt.id, runId: claim.run.id, attemptId: claim.attemptId, projectId: claim.run.projectId,
        environmentId: claim.run.environmentId, targetSha256: hash(canonical(target)), inputSha256: receipt.inputSha256, step: step ?? null };
}
function writeSeal(path, seal) {
    const fd = openSync(join(dirname(path), "firedrill-sdk-binding.json"), "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(seal));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    const parent = openSync(dirname(path), "r");
    try {
        fsyncSync(parent);
    }
    finally {
        closeSync(parent);
    }
}
function boundServices(claim, tools, binding) {
    let origin;
    try {
        origin = new URL(binding.apiUrl);
    }
    catch {
        throw fail("ISOLATED_ORIGIN_INVALID", "A trusted API origin is required for host-only run connections.");
    }
    const loopback = ["127.0.0.1", "[::1]"].includes(origin.hostname);
    if (origin.origin !== binding.apiUrl || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || !["http:", "https:"].includes(origin.protocol) || origin.protocol === "http:" && !loopback)
        throw fail("ISOLATED_ORIGIN_INVALID", "Use an exact HTTPS API origin or explicitly acknowledged literal loopback origin.");
    if (loopback && Object.keys(tools).length && binding.allowLoopbackServices !== true)
        throw fail("ISOLATED_LOOPBACK_NOT_ACKNOWLEDGED", "Local run-service transport requires explicit allowLoopbackServices: true.");
    return Object.entries(tools).map(([alias, tool]) => {
        const connection = tool.connection("http"), query = new URLSearchParams({ projectId: claim.run.projectId, environmentId: claim.run.environmentId });
        if (connection.audience !== "http" || connection.url !== `${origin.origin}/v1/service-instances/${tool.instanceId}/operations?${query}` || !/^fdsc_[A-Za-z0-9_-]{43}$/.test(connection.token) || !Number.isFinite(Date.parse(connection.expiresAt)))
            throw fail("ISOLATED_TOOL_BINDING_MISMATCH", "A Tool connection does not match the trusted origin and claimed scope.");
        return { alias, url: connection.url, token: connection.token, projectId: claim.run.projectId, environmentId: claim.run.environmentId,
            instanceId: tool.instanceId, operations: [...tool.operations], expiresAt: connection.expiresAt, ...(loopback ? { allowLoopback: true } : {}) };
    });
}
function outcome(claim, receipt, tools, signal) {
    const path = receipt.receiptPath;
    if (receipt.cleanup?.status !== "confirmed" || !receipt.cleanup.resources.every(item => ["removed", "absent"].includes(item.state)))
        throw fail("ISOLATED_CLEANUP_PENDING", "Target cleanup is not confirmed; this invocation cannot finish yet.", path, true);
    if (["pending", "retained"].includes(receipt.attachments?.status))
        throw fail("ISOLATED_ATTACHMENTS_PENDING", "Original evidence upload is not confirmed; the target will not be re-invoked.", path, true);
    if (!["none", "available", "rejected", "unavailable"].includes(receipt.attachments?.status) || !Array.isArray(receipt.attachments.items) ||
        receipt.attachments.status === "none" && receipt.attachments.items.length !== 0 ||
        receipt.attachments.status === "available" && receipt.attachments.items.some(item => item.state !== "available" || item.reference?.state !== "available" || item.reference.id !== item.artifact.id ||
            item.reference.runId !== claim.run.id || item.reference.attemptId !== claim.attemptId || item.reference.sha256 !== item.artifact.sha256 || item.reference.bytes !== item.artifact.bytes))
        throw fail("ISOLATED_ATTACHMENTS_INVALID", "Retained attachment acknowledgements do not match this exact run, attempt and content.", path, true);
    if (!["not_started", "completed", "failed", "cancelled", "timeout", "output_limit", "invalid_output", "unknown"].includes(receipt.execution?.status))
        throw fail("ISOLATED_RECEIPT_INVALID", "The adapter did not retain a recognized execution state.", path, true);
    if (receipt.relay?.status === "error" || receipt.relay?.bound?.status === "error")
        throw fail("ISOLATED_RELAY_UNCONFIRMED", "The isolated service bridge failed; retain and reconcile this invocation.", path, true);
    const captured = redactToolSecrets(receipt.execution, tools);
    if (["unknown", "not_started"].includes(captured.status))
        captured.output = null;
    if (typeof captured.stdout !== "string" || typeof captured.stderr !== "string" || Buffer.byteLength(captured.stdout) + Buffer.byteLength(captured.stderr) > claim.limits.maxOutputBytes)
        throw fail("ISOLATED_RECEIPT_INVALID", "Retained output exceeds the admitted output bound or has an invalid representation.", path, true);
    const parsed = JsonSchema.safeParse(captured.output);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(captured.output)) > claim.limits.maxOutputBytes)
        throw fail("ISOLATED_RECEIPT_INVALID", "The retained target output is not bounded JSON.", path, true);
    const events = [event("runner.prepared", { target: "isolated_node", isolation: "container", image: receipt.image, attemptId: claim.attemptId,
            targetInvocationVersion: TARGET_INVOCATION_VERSION }),
        event("runner.isolated_dispatch", { receiptId: receipt.id, boundary: "adapter_invocation", startedAttestation: false }),
        event("runner.isolated_observed", { receiptId: receipt.id, status: captured.status, exitCode: captured.exitCode, cleanup: receipt.cleanup.status, attachments: receipt.attachments.status })];
    // The current adapter has no positive guest-exec start acknowledgement. Never manufacture runner.started.
    for (const [stream, text] of [["stdout", captured.stdout], ["stderr", captured.stderr]]) {
        if (!text.length)
            events.push(event(`runner.${stream}`, { text: "", offset: 0 }));
        for (let offset = 0; offset < text.length; offset += 16384)
            events.push(event(`runner.${stream}`, { text: text.slice(offset, offset + 16384), offset }));
    }
    let execution = captured.status === "completed" ? "completed" : ["failed", "invalid_output", "output_limit"].includes(captured.status) ? "error" : "interrupted";
    if (captured.status === "cancelled" && String(signal?.reason).includes("CANCELLED"))
        execution = "cancelled";
    let reason = captured.status === "unknown" ? "Target completion is unknown; exact local cleanup is confirmed. The target was not replayed."
        : captured.status === "not_started" ? "Target launch was not confirmed; exact local cleanup is confirmed. No fallback was invoked."
            : captured.reason ?? (execution === "completed" ? null : `Isolated execution ended as ${captured.status}.`);
    if (["rejected", "unavailable"].includes(receipt.attachments.status) || receipt.infrastructureError) {
        execution = "interrupted";
        reason = "The target was observed but required capture/infrastructure completion was not confirmed; preserve the original receipt.";
    }
    return { execution, output: parsed.data, reason, events, metrics: { isolation: "container", isolationReceiptId: receipt.id, cleanup: "confirmed",
            boundServiceCalls: receipt.relay.bound?.calls ?? 0, uncertainServiceCalls: receipt.relay.bound?.uncertain ?? 0 } };
}
let active = 0;
/** Injected customer runner only. No private runtime import, dependency installation, pull or native fallback. */
export async function executeIsolated(claim, outer, attach, tools, binding, onPrepared, step) {
    bindingReady(binding);
    const target = declaration(claim);
    if (active >= 2)
        throw fail("ISOLATED_CAPACITY", "This SDK process permits at most two isolated invocations at once.");
    active++;
    let pointer, prepared = false, preparationError;
    try {
        const selected = sourceFiles(target, binding.directory), connections = boundServices(claim, tools, binding);
        const envelope = { schemaVersion: TARGET_INVOCATION_VERSION,
            input: claim.run.scenario.input, scenario: targetScenario(claim.run.scenario), configuration: claim.run.configuration, runId: claim.run.id,
            attemptId: claim.attemptId, tools: Object.fromEntries(Object.entries(tools).map(([alias, tool]) => [alias, tool.toJSON()])), ...(step ? { step } : {}) };
        const serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized) > 1024 * 1024)
            throw fail("ISOLATED_INPUT_BOUND", "The isolated input envelope exceeds 1 MiB.");
        await binding.adapter.runIsolated({ files: selected, entrypoint: target.entrypoint, input: JSON.parse(serialized), approvedServices: target.approvedServices ?? [],
            boundServices: connections, signal: outer, timeoutMs: claim.limits.timeoutMs, maxOutputBytes: claim.limits.maxOutputBytes, attach,
            onPrepared: async (path) => {
                pointer = path;
                try {
                    const receipt = receiptAt(path, target);
                    if (receipt.phase !== "planned" || receipt.execution.status !== "not_started" || receipt.inputSha256 !== hash(serialized))
                        throw fail("ISOLATED_PREPARATION_MISMATCH", "Adapter preparation does not match this invocation before launch.", path, true);
                    writeSeal(path, sealFor(claim, target, receipt, step));
                    await onPrepared(path);
                    prepared = true;
                }
                catch (error) {
                    preparationError = error;
                    throw error;
                }
            } });
        if (preparationError)
            throw preparationError;
        if (!pointer || !prepared)
            throw fail("ISOLATED_PREPARATION_UNCONFIRMED", "The adapter did not acknowledge a durable pre-launch receipt pointer.", pointer, true);
        return outcome(claim, receiptAt(pointer, target), tools, outer);
    }
    catch (error) {
        if (error instanceof FiredrillError)
            throw error;
        throw fail(pointer ? "ISOLATED_RECOVERY_REQUIRED" : "ISOLATED_RUNTIME_UNAVAILABLE", pointer ? "Isolated execution could not be reconciled; its original receipt was preserved." : "The selected source or prepared isolated runtime is unavailable; no fallback runner was selected.", pointer, Boolean(pointer));
    }
    finally {
        active--;
    }
}
/** Cleanup and retained upload only. This path never reads selected source or invokes runIsolated. */
export async function reconcileIsolatedExecution(claim, receiptPath, attach, tools, binding, step) {
    bindingReady(binding);
    const target = declaration(claim);
    try {
        let receipt = receiptAt(receiptPath, target);
        const seal = privateJson(join(dirname(receiptPath), "firedrill-sdk-binding.json"), 8192);
        if (canonical(seal) !== canonical(sealFor(claim, target, receipt, step)))
            throw fail("ISOLATED_RECOVERY_SCOPE_MISMATCH", "This local isolation receipt belongs to another run, attempt, scope or sequence step.", receiptPath, true);
        await binding.adapter.reconcileIsolated(receiptPath);
        receipt = receiptAt(receiptPath, target);
        if (receipt.cleanup.status !== "confirmed")
            throw fail("ISOLATED_CLEANUP_PENDING", "Exact isolated resource cleanup remains unconfirmed.", receiptPath, true);
        if (["retained", "pending"].includes(receipt.attachments.status)) {
            await binding.adapter.attachIsolatedEvidence(receiptPath, attach);
            receipt = receiptAt(receiptPath, target);
        }
        return outcome(claim, receipt, tools);
    }
    catch (error) {
        if (error instanceof FiredrillError)
            throw error;
        throw fail("ISOLATED_RECOVERY_REQUIRED", "Original isolated resources or evidence remain unresolved; the target was not re-invoked.", receiptPath, true);
    }
}

import { FiredrillError } from "../sdk/index.js";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/** A handoff for the caller's runner, never a dispatch or a new client operation. */
export function batchContinuation(batch, selection) {
    const reconciliation = {
        tool: "firedrill_create_batch",
        apiUrl: selection.apiUrl,
        projectId: selection.projectId,
        environmentId: selection.environmentId,
        operationKey: selection.operationKey,
        note: "Keep the original recipe, submission origin and any CI context with this key. Reuse the exact original tool input only to reconcile batch creation; never choose a new key to recover an uncertain response.",
    };
    if (!record(batch) || !safeId(batch.id) || !safeId(batch.projectId) || !safeId(batch.environmentId) ||
        batch.projectId !== selection.projectId || batch.environmentId !== selection.environmentId ||
        !record(batch.recipe) || !record(batch.recipe.target) || batch.recipe.target.kind !== selection.target.kind) {
        throw new FiredrillError("FD_MCP_BATCH_RECEIPT_UNCONFIRMED", "The service did not confirm the created batch's identity, scope and target kind.", "Preserve the original submission and operation key. No runner command is offered for this unconfirmed response; do not create a replacement batch.", { uncertain: true, validation: { reconciliation } });
    }
    const batchId = batch.id;
    const scopedCommand = (action) => {
        const argv = ["firedrill", action, batchId, "--api-url", selection.apiUrl,
            "--project", selection.projectId, "--environment", selection.environmentId,
            "--view", "operator", "--json", "--non-interactive"];
        return { argv, command: `firedrill ${argv.slice(1).map(quote).join(" ")}` };
    };
    const common = {
        batchId,
        apiUrl: selection.apiUrl,
        projectId: selection.projectId,
        environmentId: selection.environmentId,
        identity: { principalId: selection.principal.id, organizationId: selection.principal.organizationId },
        targetKind: selection.target.kind,
        inspection: { ...scopedCommand("result"), readOnly: true,
            mcp: { tool: "firedrill_batch", arguments: { batchId, projectId: selection.projectId, environmentId: selection.environmentId } } },
        reconciliation,
        note: "Batch creation does not start the customer's target. Inspect retained state before attaching a runner; this receipt does not prove queued work is still unclaimed or that any execution completed. Use the same authorized identity and exact scope. CLI configuration or environment conflicts must be resolved deliberately, not bypassed. Credentials are not embedded.",
        runnerRecovery: "If a customer runner has already started, keep its actual emitted operation ID and private journal, and resume that operation through the original runner. The batch creation key is not a runner operation ID; do not start another attachment to recover uncertain execution.",
    };
    if (selection.target.kind === "command" || selection.target.kind === "http") {
        return { ...common, kind: "cli_runner", ...scopedCommand("run"),
            execution: "Run this command from the customer's prepared repository only when execution is authorized. It attaches to this retained batch; it does not submit another recipe. The command/HTTP target runs through that customer-owned process, not the remote MCP server." };
    }
    const clientOptions = { apiUrl: selection.apiUrl, projectId: selection.projectId, environmentId: selection.environmentId };
    if (selection.target.kind === "native") {
        return { ...common, kind: "sdk_callback_required",
            sdk: {
                typescript: { clientOptions, method: "client.run", batchId, binding: "Pass the existing native callback as the second argument in the customer's process." },
                python: { clientOptions: { api_url: selection.apiUrl, project_id: selection.projectId, environment_id: selection.environmentId },
                    method: "client.run", batch_id: batchId, binding: "Pass the existing native callback as target in the customer's process; await the call for AsyncFiredrill." },
                concurrency: "Native callbacks share process memory. Parallel execution requires the explicit targetExecution acknowledgement already retained in the admitted recipe. run/resume cannot add that policy through allowParallel or allow_parallel; keep the original recipe unchanged.",
            },
            execution: "The CLI cannot reconstruct a native callback. The inspection command only reads retained results; execute through the SDK script that owns the real callback." };
    }
    return { ...common, kind: "sdk_isolated_adapter_required",
        sdk: { typescript: { clientOptions, method: "client.run", batchId,
                binding: "Configure the Firedrill client with isolated: { directory, adapter } using the customer's prepared source directory and isolated adapter, then call client.run(batchId) without a native callback. The selected files and image must match the retained recipe." } },
        execution: "The CLI does not prepare an isolated adapter or install an image. The inspection command only reads retained results; execute through the existing TypeScript SDK runner with its explicit isolated binding. No native or platform-hosted fallback is selected." };
}

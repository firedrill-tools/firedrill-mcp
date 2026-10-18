import { z } from "zod";
import { RETENTION_VERSION, RetentionResourceSchema, ScopeSchema } from "../contracts/index.js";
import { assertReadOnlyRequest } from "./readonly.js";
const scope = ScopeSchema.shape;
const query = (input) => new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
/** Inspection only, including a nonallocating preview. Never exposes deletion or reconciliation. */
export function registerRetentionTools(server, options) {
    if (!options.principal.capabilities.includes("read"))
        return;
    const { safe } = options;
    const request = (method, path, body, key) => {
        assertReadOnlyRequest(options.readonly, method, path);
        return options.request(method, path, body, key);
    };
    const inspection = [
        z.object({ action: z.literal("policy"), ...scope }).strict(),
        z.object({ action: z.literal("metadata"), ...scope, cursor: z.string().regex(/^ret_[a-f0-9]{24}$/).optional(), limit: z.number().int().min(1).max(100).default(25), kind: z.enum(["batch", "run", "scenario", "build", "dataset", "instance", "artifact", "recommendation"]).optional(), id: z.string().regex(/^(ret|batch|run|sbuild|dataset|instance|recommendation)_[a-f0-9]{24}$/).optional() }).strict(),
        z.object({ action: z.literal("receipt"), ...scope, removalId: z.string().regex(/^removal_[a-f0-9]{24}$/) }).strict(),
    ];
    const actions = options.principal.capabilities.includes("data:delete") ? [...inspection,
        z.object({ action: z.literal("preview"), ...scope, targets: z.array(RetentionResourceSchema).min(1).max(1000) }).strict(),
    ] : inspection;
    server.registerTool("firedrill_retention", {
        description: "Inspect current data-lifecycle policy, content-free retained metadata or one exact removal receipt. A read-only exact-target preview is advertised only with current data:delete authority. Available even in readonly mode; preview fences/deletes nothing. Expired/deleted content is not an empty successful result; backups have separate retention. No deletion, cascade consent, reconciliation, target execution or credential issuance is exposed. Human owners explicitly use CLI/SDK confirmation for removal. Follow metadata cursors unchanged; large previews require the same authorized CLI/SDK, never truncated consent.",
        inputSchema: z.object({ request: z.discriminatedUnion("action", actions) }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ request: input }) => safe(() => {
        const { action, ...selected } = input;
        if (action === "policy")
            return request("GET", `/v1/retention?${query(selected)}`);
        if (action === "metadata")
            return request("GET", `/v1/retention/metadata?${query(selected)}`);
        if (action === "receipt") {
            const { removalId, ...selectedScope } = selected;
            return request("GET", `/v1/data-removals/${encodeURIComponent(removalId)}?${query(selectedScope)}`);
        }
        return request("POST", "/v1/data-removals/preview", { ...selected, schemaVersion: RETENTION_VERSION });
    }));
}

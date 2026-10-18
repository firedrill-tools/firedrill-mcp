import { JsonSchema, type ClaimedRun, type Json, type ServiceBinding } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
import type { ServiceActionResult } from "./services.js";

export interface RunToolConnection {
  id: string; audience: "http" | "mcp"; url: string; token: string; expiresAt: string;
  /** Provider-shaped HTTP routes declared by this service only, not a full vendor API. */
  nativeHttpBaseUrl?: string; scopeHeaders?: { "x-fd-project-id": string; "x-fd-environment-id": string };
}
interface BindingWire {
  instanceId: string; epoch: number; buildId: string; datasetId: string | null; seed: string; operations: string[];
  connections: { http: RunToolConnection; mcp: RunToolConnection };
}
const mismatch = () => new FiredrillError("TOOL_BINDING_MISMATCH", "Prepared Tools do not match this case's selected scope and recipe.", "Preserve the operation and inspect its service bindings. No target was invoked.");

/** Only the current run's derived authority; never an operator token or runner lease. */
export class RunTool {
  readonly instanceId: string;
  readonly epoch: number;
  readonly buildId: string;
  readonly datasetId: string | null;
  readonly seed: string;
  readonly operations: readonly string[];
  readonly #wire: BindingWire;
  constructor(wire: BindingWire) {
    this.#wire = structuredClone(wire);
    this.instanceId = wire.instanceId; this.epoch = wire.epoch; this.buildId = wire.buildId;
    this.datasetId = wire.datasetId; this.seed = wire.seed; this.operations = Object.freeze([...wire.operations]);
  }
  toJSON() { return { instanceId: this.instanceId, epoch: this.epoch, buildId: this.buildId, datasetId: this.datasetId, seed: this.seed, operations: this.operations }; }
  /** Explicit secret export for an existing HTTP or MCP client. Do not log it. */
  connection(audience: "http" | "mcp"): RunToolConnection {
    if (audience !== "http" && audience !== "mcp") throw new FiredrillError("TOOL_PROTOCOL_INVALID", "Choose http or mcp.", "Only the declared semantic protocols are available.");
    return structuredClone(this.#wire.connections[audience]);
  }
  async invoke<T extends Json = Json>(operationId: string, args: Record<string, Json>, options: { idempotencyKey: string; signal?: AbortSignal }): Promise<ServiceActionResult<T>> {
    if (!this.operations.includes(operationId)) throw new FiredrillError("TOOL_OPERATION_DENIED", "This operation is not allowed by the case binding.", "Use the recipe's explicit allowed operations.");
    if (!args || typeof args !== "object" || Array.isArray(args) || !JsonSchema.safeParse(args).success) throw new FiredrillError("TOOL_INPUT_INVALID", "Tool arguments must be a JSON object.", "Supply arguments declared by this service operation.");
    const key = options?.idempotencyKey;
    if (typeof key !== "string" || !key.trim() || key.length > 200 || /[\r\n]/.test(key)) throw new FiredrillError("IDEMPOTENCY_REQUIRED", "A stable operation key is required.", "Reuse the same key and arguments to reconcile an uncertain Tool call.");
    const binding = this.#wire.connections.http;
    try {
      const response = await fetch(binding.url, { method: "POST", headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ operationId, arguments: args }), signal: options.signal ?? AbortSignal.timeout(30000), redirect: "error" });
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try { if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 16 * 1024 * 1024) throw new Error("response bound"); chunks.push(chunk.value); } }
      finally { await reader?.cancel().catch(() => {}); }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok) throw new FiredrillError(value.error?.code ?? "TOOL_REJECTED", value.error?.message ?? "Tool call rejected.", value.error?.repair ?? "Inspect the retained Tool activity.", { status: response.status });
      return value;
    } catch (error) {
      if (error instanceof FiredrillError) throw error;
      throw new FiredrillError("TOOL_RESPONSE_UNCERTAIN", "The Tool call acknowledgement could not be confirmed.", "Reconcile using this exact operation key and arguments. Do not rerun the agent to retry one Tool call.", { uncertain: true });
    }
  }
}
export type RunTools = Readonly<Record<string, RunTool>>;

export function prepareRunTools(value: unknown, definitions: ServiceBinding[], claim: ClaimedRun, origin: string): RunTools {
  const raw = value as { bindings?: Record<string, BindingWire> };
  if (!raw?.bindings || typeof raw.bindings !== "object" || Array.isArray(raw.bindings) || Object.keys(raw.bindings).length !== definitions.length) throw mismatch();
  const result: Record<string, RunTool> = Object.create(null);
  for (const definition of definitions) {
    const wire = raw.bindings[definition.alias];
    if (!wire || !/^[a-zA-Z0-9_-]{1,160}$/.test(wire.instanceId) || !Number.isSafeInteger(wire.epoch) || wire.epoch < 0 || wire.buildId !== definition.buildId || wire.datasetId !== (claim.run.scenario.serviceDatasets?.[definition.alias] ?? definition.datasetId ?? null) || wire.seed !== definition.seed || JSON.stringify(wire.operations) !== JSON.stringify(definition.operations)) throw mismatch();
    for (const audience of ["http", "mcp"] as const) {
      const connection = wire.connections?.[audience];
      const query = new URLSearchParams({ projectId: claim.run.projectId, environmentId: claim.run.environmentId });
      if (!connection || connection.audience !== audience || connection.url !== `${origin}/v1/service-instances/${wire.instanceId}/${audience === "http" ? "operations" : "mcp"}?${query}` || !/^fdsc_[A-Za-z0-9_-]{43}$/.test(connection.token) || !Number.isFinite(Date.parse(connection.expiresAt))) throw mismatch();
      if (connection.nativeHttpBaseUrl !== undefined && (audience !== "http" || connection.nativeHttpBaseUrl !== `${origin}/v1/service-instances/${wire.instanceId}/http` || connection.scopeHeaders?.["x-fd-project-id"] !== claim.run.projectId || connection.scopeHeaders?.["x-fd-environment-id"] !== claim.run.environmentId)) throw mismatch();
    }
    result[definition.alias] = new RunTool(wire);
  }
  return Object.freeze(result);
}

/** Deliberate target-only envelope, not a journal or ordinary JSON representation. */
export function targetToolBindings(tools: RunTools) {
  return Object.fromEntries(Object.entries(tools).map(([alias, tool]) => [alias, { ...tool.toJSON(), connections: { http: tool.connection("http"), mcp: tool.connection("mcp") } }]));
}

/** Guard accidental target logging of its short-lived connection credentials. */
export function redactToolSecrets<T>(value: T, tools: RunTools): T {
  let serialized = JSON.stringify(value);
  for (const tool of Object.values(tools)) for (const audience of ["http", "mcp"] as const) serialized = serialized.replaceAll(tool.connection(audience).token, "[redacted Tool credential]");
  return JSON.parse(serialized) as T;
}

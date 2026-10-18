import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Principal, Scope } from "../contracts/index.js";
import { FiredrillError, batchReceipt, followBatch } from "../sdk/index.js";

type Request = (method: string, path: string, body?: unknown, key?: string, maximum?: number, scope?: Scope) => Promise<any>;
type Safe = (action: () => Promise<unknown>) => Promise<any>;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);

export function registerFollowTool(server: McpServer, options: { principal: Principal; request: Request; safe: Safe }) {
  if (!options.principal.capabilities.includes("read")) return;
  server.registerTool("firedrill_lifecycle", {
    description: "Read metadata-only evidence completeness and cleanup/recovery facts for one batch in exact selected scope. Works while metadata is retained even after recipe/output expiry or deletion. Does not restore content, launch a target, claim successful cleanup or reassess evidence.",
    inputSchema: z.object({ batchId: id, projectId: id, environmentId: id }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ batchId, projectId, environmentId }) => options.safe(() => options.request("GET",
    `/v1/batches/${encodeURIComponent(batchId)}/lifecycle`, undefined, undefined, 256 * 1024, { projectId, environmentId })));
  server.registerTool("firedrill_follow", {
    description: "Observe one existing batch in explicit project/environment for at most 30 seconds. Uses compact retained results and whole-population counts; starts no target, claims no work, cancels nothing and requests no assessment. settled means execution and assessment are terminal, not successful. Timeout/interruption/read_error preserve a clearly labelled last-confirmed snapshot and exact continuation. Unavailable content returns metadata-only lifecycle when still retained, never a settled result. Rejected authority produces a typed error. Read endpoints may reconcile expired leases server-side.",
    inputSchema: z.object({ batchId: id, projectId: id, environmentId: id,
      timeoutMs: z.number().int().min(0).max(30000).default(10000),
      pollIntervalMs: z.number().int().min(250).max(30000).default(1000) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ batchId, projectId, environmentId, timeoutMs, pollIntervalMs }) => options.safe(async () => {
    try {
    const value = await followBatch(batchId, { scope: { projectId, environmentId }, read: async path => {
      try { return await options.request("GET", path, undefined, undefined, 32 * 1024 * 1024, { projectId, environmentId }); }
      catch (error) {
        if (error instanceof FiredrillError) throw error;
        if (error && typeof error === "object" && "publicError" in error) {
          const detail = error.publicError as { code?: unknown; message?: unknown; repair?: unknown; status?: number } | undefined;
          if (detail && typeof detail.code === "string") throw new FiredrillError(detail.code,
            typeof detail.message === "string" ? detail.message : "Retained read rejected.",
            typeof detail.repair === "string" ? detail.repair : "Inspect the original batch and authorized scope.",
            { status: "responseStatus" in error && typeof error.responseStatus === "number" ? error.responseStatus : detail.status, batchId });
        }
        if (error && typeof error === "object" && "responseStatus" in error && typeof error.responseStatus === "number"
          && error.responseStatus >= 400 && error.responseStatus < 500)
          throw new FiredrillError("FOLLOW_READ_REJECTED", "The service rejected this retained read; its error body was unavailable.",
            "Inspect authorization, original scope and retained-content availability. Do not use a cached snapshot as current authorized evidence.",
            { status: error.responseStatus, batchId });
        throw error;
      }
    } }, { timeoutMs, pollIntervalMs });
    return { ...value, result: batchReceipt(value.result) };
    } catch (error) {
      if (!(error instanceof FiredrillError) || !["FD_CONTENT_UNAVAILABLE", "FD_CONTENT_EXPIRED", "FD_CONTENT_DELETED", "FD_CONTENT_DELETION_PENDING"].includes(error.code)) throw error;
      // followBatch already attempted metadata inside the observer deadline.
      const retainedLifecycle = error.details.retainedLifecycle;
      if (!retainedLifecycle || retainedLifecycle.batchId !== batchId || retainedLifecycle.projectId !== projectId || retainedLifecycle.environmentId !== environmentId) throw error;
      return { state: "content_unavailable", batchId, projectId, environmentId, error: { code: error.code, message: error.message }, retainedLifecycle,
        note: "Observation could not read retained content. This is metadata only, not a settled or successful simulation. No target was started or content restored.",
        nextAction: { tool: "firedrill_lifecycle", arguments: { batchId, projectId, environmentId } } };
    }
  }));
}

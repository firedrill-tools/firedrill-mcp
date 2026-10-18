import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CapacityRequestSchema, CapacityRequestPageSchema, ScopeSchema, type Principal } from "../contracts/index.js";

export function registerCapacityTools(server: McpServer, options: {
  principal: Principal; readonly?: boolean;
  request: (method: string, path: string, body?: unknown, key?: string) => Promise<any>;
  safe: (fn: () => Promise<any>) => Promise<any>;
}) {
  server.registerTool("firedrill_capacity_requests", {
    description: "Read saved capacity requests in one authorized project/environment. Follow nextCursor; notification sent means provider acceptance, not delivery. Does not change capacity or run simulations.",
    inputSchema: ScopeSchema.extend(CapacityRequestPageSchema.shape).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ projectId, environmentId, cursor, limit }) => options.safe(() => options.request("GET", `/v1/capacity-requests?${new URLSearchParams({ projectId, environmentId, limit: String(limit), ...(cursor ? { cursor } : {}) })}`)));
  if (options.readonly || !options.principal.capabilities.includes("read")) return;
  server.registerTool("firedrill_request_capacity", {
    description: "Save a scoped request for more shared runs, synthetic Tools or storage capacity and notify the configured operator. Requires user intent; do not include credentials or simulation contents. Persist operationKey and exact input before dispatch, then reuse both after uncertainty. This requests review only: no capacity is granted, target executed or delivery guaranteed.",
    inputSchema: CapacityRequestSchema.extend({ operationKey: z.string().regex(/^[\x21-\x7e]{1,200}$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ operationKey, ...body }) => options.safe(() => options.request("POST", "/v1/capacity-requests", body, operationKey)));
}

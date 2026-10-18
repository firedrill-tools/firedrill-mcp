import type { Scope } from "./index.js";

/** Selected read intent, never a substitute for credential/tenant authority. */
export const READ_SCOPE_VERSION = "2026-10-16-read-scope.1" as const;
export const READ_SCOPE_HEADERS = {
  version: "x-fd-read-scope-version", project: "x-fd-read-project-id", environment: "x-fd-read-environment-id",
} as const;

export function isScopedResourceRead(method: string, route: string): boolean {
  return method === "GET" && /^\/v1\/(?:runs|batches)\/[A-Za-z0-9_-]+(?:\/[^?#]*)?$/.test(route.split("?")[0]!);
}

export function readScopeHeaders(scope: Scope): Record<string, string> {
  for (const value of [scope.projectId, scope.environmentId])
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new TypeError("A selected read needs a bounded project/environment pair.");
  return { [READ_SCOPE_HEADERS.version]: READ_SCOPE_VERSION,
    [READ_SCOPE_HEADERS.project]: scope.projectId, [READ_SCOPE_HEADERS.environment]: scope.environmentId };
}

export function readScopeConfirmed(headers: { get(name: string): string | null }, scope: Scope): boolean {
  return headers.get(READ_SCOPE_HEADERS.version) === READ_SCOPE_VERSION
    && headers.get(READ_SCOPE_HEADERS.project) === scope.projectId
    && headers.get(READ_SCOPE_HEADERS.environment) === scope.environmentId;
}

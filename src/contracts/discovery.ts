/** Public product metadata only. Discovery never grants authority or reserves work. */
export const DISCOVERY_VERSION = "2026-10-15-discovery.1" as const;
export const AUTHORING_SCHEMA_IDS = [
  "recipe", "scenario", "target", "target-invocation", "rubric", "exact-check", "sequence",
  "service-binding", "population", "recipe-preview", "scenario-save",
  "reassessment", "run-intervention", "artifact", "machine-credential",
  "service-publication", "service-dataset", "service-instance", "service-connection",
  "dataset-policy", "dataset-metadata", "ci-context", "activity-filters", "composite-policy", "population-purpose", "task-metric",
] as const;
export type AuthoringSchemaId = typeof AUTHORING_SCHEMA_IDS[number];
export interface AuthoringSchemaEntry {
  id: AuthoringSchemaId; description: string; path: string;
}
export interface ProductCapability {
  id: string; description: string;
  operations: { method: "GET" | "POST"; path: string; effect: "read" | "prepare" | "mutate" | "evaluate";
    requires: string[]; authorized: boolean }[];
  limitations: string[];
}
export interface ProductDiscovery {
  schemaVersion: typeof DISCOVERY_VERSION;
  contractVersion: string;
  acceptedRecipeVersions: string[];
  authority: { permissions: string[]; scopePath: "/v1/context"; advisoryOnly: true };
  /** Optional on older services; absence does not confirm selected-context reads. */
  readScope?: { schemaVersion: typeof import("./read-scope.js").READ_SCOPE_VERSION;
    headers: typeof import("./read-scope.js").READ_SCOPE_HEADERS;
    appliesTo: "GET_runs_and_batches_by_id"; credentialAuthorityUnchanged: true;
    unselectedDirectLinks: "credential_authorized" };
  execution: { owner: "customer_runner"; batchCreationExecutesTarget: false;
    toolsRequired: false; assessmentRequired: false; nativeProcessIsSandbox: false };
  assessment: { configured: boolean; rubricScale: [0, 1, 2, 3, 4];
    supportedEvidenceKinds: ["text"]; scoreIsProbability: false; evaluatorFailureIsTargetFailure: false };
  capacity: { maxActiveRuns: number; resourceBounds: Record<string, number | null>; reservation: false };
  capabilities: ProductCapability[];
  schemas: AuthoringSchemaEntry[];
  authoring: { format: "json-schema-2020-12"; semantics: "structural_input_only";
    previewPath: "/v1/recipes/preview"; limitations: string[] };
  recovery: { situation: string; action: string }[];
  /** Additive response contracts; older deployments may omit these capabilities. */
  resultProjections?: {
    lifecycle: { schemaVersion: typeof import("./result-lifecycle.js").RESULT_LIFECYCLE_VERSION; path: "/v1/batches/{id}/result?compact=1";
      metadataPath?: "/v1/batches/{id}/lifecycle";
      coverage: "whole_batch"; evidenceScope: "declared_artifacts_and_run_owned_tools"; customerCleanup: "runner_reported_not_platform_attested" };
    batchOverview: { schemaVersion: typeof import("./batch-overview.js").BATCH_OVERVIEW_VERSION; path: "/v1/batches";
      scoring: "one_named_dimension_only_when_contracts_match" };
  };
}
export interface AuthoringSchemaDocument {
  schemaVersion: typeof DISCOVERY_VERSION; contractVersion: string; id: AuthoringSchemaId;
  description: string; format: "json-schema-2020-12"; semantics: "structural_input_only";
  /** Digest covers the complete root schema, even when selecting one subtree. */
  sha256: string; pointer: string; rootPath: string; value: unknown;
  limitations: string[];
}

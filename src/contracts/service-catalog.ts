import type { Scope } from "./index.js";

/** Additive catalog wire contract; existing simulation recipes are unchanged. */
export const SERVICE_CATALOG_VERSION = "2026-10-15-catalog.1" as const;
export interface ServiceCatalogRelease {
  id: string;
  name: string;
  version: string;
  releaseDigest: string;
  description: string;
  operations: { id: string; description: string }[];
  fidelity: {
    interfaces: ("semantic-api" | "mcp" | "declarative-ui" | "browser-ui")[];
    providerNativeHttp: false;
    vendorUi: false;
    description: string;
  };
  starter: { records: number; initialVirtualTimeUs: number; synthetic: true };
  license: string;
}
export interface ServiceCatalogPage {
  schemaVersion: typeof SERVICE_CATALOG_VERSION;
  items: ServiceCatalogRelease[];
}
export interface AcquireServiceCatalogInput extends Scope {
  catalogId: string;
  releaseDigest: string;
  initialData: "empty" | "starter";
}
export type ServiceCatalogAcquisitionPhase = "prepared" | "building" | "seeding" | "ready" | "failed" | "uncertain";
/** These are project-owned publication IDs, never a target execution or grant. */
export interface ServiceCatalogAcquisition extends AcquireServiceCatalogInput {
  schemaVersion: typeof SERVICE_CATALOG_VERSION;
  id: string;
  phase: ServiceCatalogAcquisitionPhase;
  buildId: string | null;
  datasetId: string | null;
  error: { code: string; repair: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Public reporting metadata only. Neither App credentials nor workflow identity tokens are returned. */
export const GITHUB_CI_VERSION = "2026-10-18-github-ci.1" as const;
export interface GitHubConnectionMetadata {
  id: string; projectId: string; environmentId: string; repository: string; repositoryUrl: string;
  workflowPath: string; state: "active" | "suspended" | "revoked"; createdAt: string; verifiedAt: string;
}
export interface GitHubConnectionPage {
  schemaVersion: typeof GITHUB_CI_VERSION; items: GitHubConnectionMetadata[]; nextCursor: string | null;
  availability: "available" | "disabled"; code?: string;
}
export interface GitHubPublicationReceipt {
  schemaVersion: typeof GITHUB_CI_VERSION; batchId: string; state: "published" | "not_connected" | "unavailable";
  connection?: GitHubConnectionMetadata; checkUrl?: string; commentUrl?: string; code?: string; repair?: string;
}

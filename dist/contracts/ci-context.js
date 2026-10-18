import { z } from "zod";
export const CI_CONTEXT_VERSION = "2026-10-16-ci-context.1";
export const CI_REPORT_VERSION = "2026-10-16-ci-report.1";
const text = (maximum) => z.string().min(1).max(maximum).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a bounded nonsecret value without control characters.");
const repository = z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .refine(value => value.split("/").every(part => part !== "." && part !== ".."), "Use the exact owner/repository identity.");
const server = z.string().max(512).refine(value => {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value
            && !url.username && !url.password && !url.search && !url.hash;
    }
    catch {
        return false;
    }
}, "Use the canonical HTTPS GitHub server origin without credentials, path, query or fragment.");
/** Immutable caller-declared source context, never signed workflow or target-execution attestation. */
export const CiContextSchema = z.object({
    schemaVersion: z.literal(CI_CONTEXT_VERSION), provider: z.literal("github"),
    serverUrl: server, repository,
    runId: z.string().regex(/^[1-9][0-9]{0,23}$/),
    runAttempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    ref: text(512).optional(), workflow: text(200).optional(), job: text(100).optional(),
    event: text(100).optional(), pullRequest: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
/** Revalidate retained declarations before deriving clickable external URLs. */
export function ciContextLinks(input) {
    const parsed = CiContextSchema.safeParse(input);
    if (!parsed.success)
        return null;
    const value = parsed.data, base = `${value.serverUrl}/${value.repository.split("/").map(encodeURIComponent).join("/")}`;
    return { run: `${base}/actions/runs/${value.runId}/attempts/${value.runAttempt}`,
        commit: `${base}/commit/${value.commit}`,
        ...(value.pullRequest === undefined ? {} : { pullRequest: `${base}/pull/${value.pullRequest}` }) };
}

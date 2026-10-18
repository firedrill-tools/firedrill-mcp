import { createHash } from "node:crypto";
import { z } from "zod";
// Presentation only: the service owns sequence semantics and authority. Unknown
// retained payloads are never spread into ordinary operator output.
const record = z.object({ execution: z.string().max(32), session: z.object({ phase: z.string().max(32), execution: z.string().max(32), step_index: z.number().int(),
        started_at: z.string().max(80), deadline_at: z.string().max(80), finished_at: z.string().max(80).nullable(), output: z.unknown(), reason: z.unknown(), metrics: z.unknown() }).nullable(),
    steps: z.array(z.object({ ordinal: z.number().int().min(0).max(63), step_id: z.string().max(160), phase: z.string().max(32),
        input: z.record(z.string(), z.unknown()), result: z.unknown(), poll_attempt: z.number().int(), started_at: z.string().max(80), finished_at: z.string().max(80).nullable() })).max(64) });
export function sequenceMetadata(runId, input) {
    const value = record.parse(input), apiPath = `/v1/runs/${encodeURIComponent(runId)}/sequence`;
    const omitted = (payload, pointer) => { const text = JSON.stringify(payload ?? null); return { omitted: true, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), pointer }; };
    return { runId, apiPath, readMode: "metadata_only", pagination: "not_supported", payloadsIncluded: false, execution: value.execution,
        session: value.session && { phase: value.session.phase, execution: value.session.execution, stepIndex: value.session.step_index, startedAt: value.session.started_at, deadlineAt: value.session.deadline_at, finishedAt: value.session.finished_at,
            output: omitted(value.session.output, "/session/output"), reason: omitted(value.session.reason, "/session/reason"), metrics: omitted(value.session.metrics, "/session/metrics") },
        retainedSteps: value.steps.length, steps: value.steps.map((step, index) => ({ ordinal: step.ordinal, stepId: step.step_id, phase: step.phase,
            kind: typeof step.input.kind === "string" && step.input.kind.length < 32 ? step.input.kind : "unknown", pollAttempts: step.poll_attempt, startedAt: step.started_at, finishedAt: step.finished_at,
            pointer: `/steps/${index}`, input: omitted(step.input, `/steps/${index}/input`), result: omitted(step.result, `/steps/${index}/result`) })),
        note: "All retained step identities are included, not all declared future steps. Input/result payloads are deliberately omitted. Resolve pointers in the exact authorized API response; this endpoint has no pages. Reading does not advance or re-execute a step." };
}

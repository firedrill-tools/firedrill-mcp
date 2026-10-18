import { CI_CONTEXT_VERSION, CiContextSchema, INSPECTION_VERSION, KnownSubmissionOriginSchema, type CiContext, type SubmissionMetadata } from "../contracts/index.js";
import { FiredrillError, definitionError } from "./errors.js";

type Input = { submissionOrigin?: SubmissionMetadata["origin"]; ciContext?: CiContext };
function checked(value: unknown): CiContext {
  const parsed = CiContextSchema.safeParse(value);
  if (!parsed.success) throw definitionError("CI_CONTEXT_INVALID", "Declared CI context is malformed.", "Supply only bounded nonsecret GitHub metadata matching the CI context schema. No new simulation was admitted.", parsed.error.issues);
  return parsed.data;
}
const integer = (value: string | undefined) => value && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
/** Read a fixed metadata allowlist only; no event file, git command or environment dump. */
export function newSubmission(input: Input): SubmissionMetadata {
  const origin = KnownSubmissionOriginSchema.safeParse(input.submissionOrigin ?? process.env.FIREDRILL_SUBMISSION_ORIGIN ?? "sdk");
  if (!origin.success) throw definitionError("SUBMISSION_INVALID", "Submission origin is invalid.", "Use cli, sdk, mcp, ci or api. Declared provenance is not execution attestation.", origin.error.issues);
  if (input.ciContext !== undefined && origin.data !== "ci") throw new FiredrillError("CI_CONTEXT_ORIGIN_CONFLICT", "CI context requires explicit ci submission origin.", "Set submissionOrigin to ci for a new CI submission, or omit ciContext. No new simulation was admitted.");
  let ci = input.ciContext === undefined ? undefined : checked(input.ciContext);
  if (ci === undefined && origin.data === "ci" && process.env.GITHUB_ACTIONS === "true") {
    ci = checked({ schemaVersion: CI_CONTEXT_VERSION, provider: "github", serverUrl: process.env.GITHUB_SERVER_URL,
      repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: integer(process.env.GITHUB_RUN_ATTEMPT), commit: process.env.GITHUB_SHA,
      ...Object.fromEntries([["ref", "GITHUB_REF"], ["workflow", "GITHUB_WORKFLOW"], ["job", "GITHUB_JOB"], ["event", "GITHUB_EVENT_NAME"]]
        .flatMap(([field, variable]) => process.env[variable!] === undefined ? [] : [[field, process.env[variable!]]])),
      ...(process.env.FIREDRILL_CI_PR_NUMBER === undefined || process.env.FIREDRILL_CI_PR_NUMBER === "" ? {} : { pullRequest: integer(process.env.FIREDRILL_CI_PR_NUMBER) }) });
  }
  return { schemaVersion: INSPECTION_VERSION, origin: origin.data, ...(ci ? { ci } : {}) };
}
/** Recovery/attachment never reinterpret an old submission using today's workflow environment. */
export function matchRetainedSubmission(retained: SubmissionMetadata | null | undefined, input: Input): void {
  if (input.submissionOrigin !== undefined && input.submissionOrigin !== retained?.origin) throw new FiredrillError("CI_CONTEXT_RECOVERY_CONFLICT", "The explicit submission origin differs from the retained operation.", "Omit the override or use the original declaration. Recovery does not create a new submission.");
  if (input.ciContext === undefined) return;
  const proposed = checked(input.ciContext), original = CiContextSchema.safeParse(retained?.ci);
  if (retained?.origin !== "ci" || !original.success || JSON.stringify(proposed) !== JSON.stringify(original.data)) throw new FiredrillError("CI_CONTEXT_RECOVERY_CONFLICT", "The explicit CI context differs from the retained submission.", "Resume or attach with the original context, or omit it. Do not relabel retained execution as a different workflow run.");
}

import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CI_CONTEXT_VERSION, CI_REPORT_VERSION, CiContextSchema, ciContextLinks,
  type BatchResult, type CiContext, type CiReportReceipt } from "../contracts/index.js";
import { batchReceipt } from "./batch-receipt.js";

const maximumEntry = 16 * 1024, maximumTotal = 1024 * 1024;
const executionStates = ["queued", "running", "completed", "error", "interrupted", "cancelled"] as const;
const assessmentStates = ["not_requested", "pending", "completed", "partial", "unavailable", "error"] as const;
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const unavailable = (code: NonNullable<CiReportReceipt["code"]>): CiReportReceipt => ({
  schemaVersion: CI_REPORT_VERSION, target: "github_step_summary", state: "unavailable", code,
});

function currentStep(): boolean {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== "true" || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) return false;
  const pr = env.FIREDRILL_CI_PR_NUMBER;
  if (pr !== undefined && pr !== "" && !/^[1-9][0-9]*$/.test(pr)) return false;
  return CiContextSchema.safeParse({ schemaVersion: CI_CONTEXT_VERSION, provider: "github",
    serverUrl: env.GITHUB_SERVER_URL, repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT), commit: env.GITHUB_SHA,
    ...(env.GITHUB_REF === undefined ? {} : { ref: env.GITHUB_REF }),
    ...(env.GITHUB_WORKFLOW === undefined ? {} : { workflow: env.GITHUB_WORKFLOW }),
    ...(env.GITHUB_JOB === undefined ? {} : { job: env.GITHUB_JOB }),
    ...(env.GITHUB_EVENT_NAME === undefined ? {} : { event: env.GITHUB_EVENT_NAME }),
    ...(pr === undefined || pr === "" ? {} : { pullRequest: Number(pr) }),
  }).success;
}

function reportLink(result: BatchResult): string | undefined {
  const { batch } = result;
  if (!opaque(batch.id) || !opaque(batch.projectId) || !opaque(batch.environmentId) || result.reportUrl.length > 2048) return;
  let url: URL;
  try { url = new URL(result.reportUrl); } catch { return; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return;
  const portal = url.pathname === `/app/batches/${batch.id}`;
  if (!portal && url.pathname !== `/v1/batches/${batch.id}`) return;
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!portal || !["organizationId", "projectId", "environmentId"].includes(key) || seen.has(key) || !opaque(value)) return;
    if (key === "projectId" && value !== batch.projectId || key === "environmentId" && value !== batch.environmentId) return;
    seen.add(key);
  }
  return url.href;
}

function markdown(result: BatchResult, context?: CiContext): string | undefined {
  const batch = result.batch, link = reportLink(result);
  if (!link || !Number.isSafeInteger(batch.total) || batch.total < 0 ||
      !executionStates.every(state => Number.isSafeInteger(batch.counts[state]) && batch.counts[state] >= 0) ||
      executionStates.reduce((sum, state) => sum + batch.counts[state], 0) !== batch.total ||
      !["not_configured", "allow", "block", "inconclusive"].includes(result.gate)) return;
  const assessment = batchReceipt(result).assessmentCounts;
  const original = context === undefined ? null : ciContextLinks(context);
  const evidence = result.lifecycle?.evidence?.state, recovery = result.lifecycle?.recovery?.state;
  const lifecycleText = evidence && ["not_requested", "pending", "complete", "incomplete"].includes(evidence)
    && recovery && ["required", "not_indicated"].includes(recovery)
    ? `Evidence: ${evidence} (declared captures and run-owned Tool closure records only). Recovery: ${recovery}; inspect the retained lifecycle for cleanup gaps. Customer-process stops are runner-reported, not platform-attested.`
    : "Evidence/cleanup lifecycle not reported; completeness and customer-process stop are unknown.";
  return `\n## Firedrill simulation\n\nBatch: \`${batch.id}\` · ${batch.total} retained cases\n\n` +
    `| Execution | Cases |\n| --- | ---: |\n${executionStates.map(state => `| ${state} | ${batch.counts[state]} |`).join("\n")}\n\n` +
    `Assessment: ${assessment ? assessmentStates.map(state => `${state}: ${assessment[state]}`).join(" · ") : "whole-population counts unavailable"}.\n\n` +
    `CI gate: **${result.gate}**. Execution, assessment and gate are separate; this summary does not infer success.\n\n` +
    `${lifecycleText}\n\n` +
    `[Open retained report (authentication required)](<${link}>)\n\n` +
    (original ? `[Originally submitted workflow](<${original.run}>) — caller-declared source context, not execution attestation.\n\n` : "Original workflow context was not recorded.\n\n") +
    `Written by this opted-in reporting step; a resume may report a batch submitted by another job or workflow run.\n`;
}

/** Opt-in local presentation only. Never executes, follows, reassesses or changes
 * a target result. Inputs, outputs, reasons, names and credentials are omitted. */
export function writeCiReport(result: BatchResult, context?: CiContext): CiReportReceipt | undefined {
  if (process.env.FIREDRILL_CI_REPORT !== "github_summary") return;
  let fd: number | undefined, writing = false;
  try {
    if (!currentStep() || context !== undefined && !CiContextSchema.safeParse(context).success)
      return unavailable("CI_REPORT_CONTEXT_REQUIRED");
    const text = markdown(result, context);
    if (text === undefined) return unavailable("CI_REPORT_CONTEXT_REQUIRED");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > maximumEntry) return unavailable("CI_REPORT_SIZE_LIMIT");
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (!path || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path) ||
        typeof process.getuid !== "function" || !constants.O_NOFOLLOW) return unavailable("CI_REPORT_DESTINATION_INVALID");
    // Only the runner's exact existing regular file is writable. No creation,
    // redirection, symlink traversal, alternate destination or permission edits.
    for (let part = path; ; part = dirname(part)) {
      if (lstatSync(part).isSymbolicLink()) return unavailable("CI_REPORT_DESTINATION_INVALID");
      if (dirname(part) === part) break;
    }
    if (realpathSync(path) !== path) return unavailable("CI_REPORT_DESTINATION_INVALID");
    const before = lstatSync(path), uid = process.getuid();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.mode & 0o022)
      return unavailable("CI_REPORT_DESTINATION_INVALID");
    if (before.size + bytes.length > maximumTotal) return unavailable("CI_REPORT_SIZE_LIMIT");
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd), selected = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== uid || opened.mode & 0o022 || selected.isSymbolicLink() ||
        opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== selected.dev || opened.ino !== selected.ino || opened.size !== before.size)
      return unavailable("CI_REPORT_DESTINATION_INVALID");
    if (opened.size + bytes.length > maximumTotal) return unavailable("CI_REPORT_SIZE_LIMIT");
    writing = true;
    // A short/ambiguous append is never retried, since repeating it can duplicate
    // or corrupt evidence presentation. The simulation result remains untouched.
    if (writeSync(fd, bytes, 0, bytes.length, null) !== bytes.length) return unavailable("CI_REPORT_WRITE_UNCONFIRMED");
    fsyncSync(fd);
    const after = fstatSync(fd), named = lstatSync(path);
    if (!after.isFile() || after.nlink !== 1 || after.uid !== uid || after.mode & 0o022 ||
        !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.uid !== uid || named.mode & 0o022 ||
        after.dev !== opened.dev || after.ino !== opened.ino || named.dev !== after.dev || named.ino !== after.ino ||
        after.size !== opened.size + bytes.length || after.size > maximumTotal)
      return unavailable("CI_REPORT_WRITE_UNCONFIRMED");
    return { schemaVersion: CI_REPORT_VERSION, target: "github_step_summary", state: "written" };
  } catch {
    return unavailable(writing ? "CI_REPORT_WRITE_UNCONFIRMED" : "CI_REPORT_DESTINATION_INVALID");
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* Never mask the retained simulation result. */ }
  }
}

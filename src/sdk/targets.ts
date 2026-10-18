import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { JsonSchema, TARGET_INVOCATION_VERSION, targetScenario, type TargetScenario, type ClaimedRun, type Json, type Configuration } from "../contracts/index.js";
import type { LocalEvent } from "./journal.js";
import type { AttachmentSink } from "./attachments.js";
import { redactToolSecrets, targetToolBindings, type RunTools } from "./run-tools.js";
import { executeIsolated, type IsolatedBinding } from "./isolated.js";
import { FiredrillError, targetStopUnconfirmed } from "./errors.js";
import { checkedMetrics, metricsJson, type TargetMetrics } from "./observations.js";

export interface TargetContext {
  schemaVersion: typeof TARGET_INVOCATION_VERSION;
  runId: string; attemptId: string; scenario: TargetScenario; configuration: Configuration;
  signal: AbortSignal; deadline: string;
  /** Await inside the callback. The runner journals and uploads without exposing its lease. */
  attach: AttachmentSink;
  /** Each alias is an independently seeded, run-scoped Tool. Empty for tool-free cases. */
  tools: RunTools;
  /** Bounded runner-reported evidence. Not a platform-observed side effect or verdict. */
  observe(kind: string, payload: Json): void;
  /** Report cumulative observed measurements for this invocation; omitted values stay unknown. */
  recordMetrics(metrics: TargetMetrics): void;
  step?: { ordinal: number; id: string };
}
export type NativeTarget = (input: Json, context: TargetContext) => Json | Promise<Json>;
export interface TargetOutcome { execution: "completed" | "error" | "interrupted" | "cancelled"; output: Json; reason: string | null; events: LocalEvent[]; metrics: Record<string, Json>; /** Adapter-owned cleanup fact, never supplied through recordMetrics. */ stopUnconfirmed?: true }
export function event(kind: string, payload: Json): LocalEvent { return { id: randomUUID(), kind, payload, occurredAt: new Date().toISOString() }; }
function parse(body: string): Json { try { return JSON.parse(body) as Json; } catch { return body; } }
function reason(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
function aborted(signal: AbortSignal): TargetOutcome["execution"] { return String(signal.reason?.message ?? signal.reason).includes("CANCELLED") ? "cancelled" : "interrupted"; }
function jsonValue(value: unknown, maximum: number): Json {
  JsonSchema.parse(value);
  const body = JSON.stringify(value);
  if (body === undefined || Buffer.byteLength(body) > maximum) throw new Error("OUTPUT_LIMIT: target returned unsupported or oversized JSON");
  // Round-trip explicitly rejects undefined/cycles/BigInt while retaining ordinary JSON values.
  return JSON.parse(body) as Json;
}
export async function executeTarget(claim: ClaimedRun, native: NativeTarget | undefined, outer: AbortSignal, attach: AttachmentSink, tools: RunTools = {}, step?: { ordinal: number; id: string }, isolated?: { binding: IsolatedBinding; onPrepared: (path: string) => void | Promise<void> }, onEvent?: (value: LocalEvent) => void): Promise<TargetOutcome> {
  if (claim.run.target.kind === "isolated_node") {
    if (!isolated) throw new FiredrillError("ISOLATED_RUNNER_REQUIRED", "This target requires its prepared customer-local isolated adapter.", "Supply the explicit isolated binding. No native or command fallback is used.");
    // The adapter owns enforced deadlines and exact cleanup. Do not race it with
    // a timer that could finish the run while its descendants are still alive.
    return executeIsolated(claim, outer, attach, tools, isolated.binding, isolated.onPrepared, step);
  }
  const { run, attemptId, limits } = claim;
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer.reason);
  outer.addEventListener("abort", onAbort, { once: true });
  if (outer.aborted) onAbort();
  const signal = controller.signal, started = performance.now(), deadline = started + limits.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleDeadline = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) controller.abort(new Error("TARGET_TIMEOUT: execution deadline reached"));
    else timer = setTimeout(scheduleDeadline, Math.min(remaining, 2147483647));
  };
  scheduleDeadline();
  // The task sees its input and identity, not evaluator checks, hidden datasets
  // or future sequence steps. Native code gets fresh JSON values so it cannot
  // rewrite the runner's retained claim through an object reference.
  const envelope = { schemaVersion: TARGET_INVOCATION_VERSION,
    input: JSON.parse(JSON.stringify(run.scenario.input)) as Json,
    scenario: targetScenario(run.scenario),
    configuration: JSON.parse(JSON.stringify(run.configuration)) as Configuration,
    runId: run.id, attemptId, tools: targetToolBindings(tools), ...(step ? { step: { ...step } } : {}) };
  const events: LocalEvent[] = [];
  const record = (value: LocalEvent) => { events.push(value); onEvent?.(value); };
  let reportedMetrics: TargetMetrics = {}, observationBytes = 0, observing = true;
  const observe = (kind: string, payload: Json) => {
    signal.throwIfAborted();
    if (!observing) throw new FiredrillError("OBSERVATION_CLOSED", "The invocation has already returned.", "Await all target work and observations before returning from the callback.");
    if (typeof kind !== "string" || !kind.length || kind.length > 120 || /[\x00-\x1f\x7f]/.test(kind)) throw new FiredrillError("OBSERVATION_INVALID", "Observation kind must contain 1–120 printable characters.", "Use a stable event kind and JSON payload.");
    const value = event("runner.observation", { kind, payload: JsonSchema.parse(payload), provenance: "runner_reported" });
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (observationBytes + bytes > limits.maxOutputBytes) throw new FiredrillError("OBSERVATION_LIMIT", "Runner observations exceeded this invocation's byte bound.", "Use bounded summaries or explicit artifact attachments for larger evidence.");
    observationBytes += bytes; record(JSON.parse(JSON.stringify(value)));
  };
  const recordMetrics = (input: TargetMetrics) => {
    const checked = checkedMetrics(input);
    const next = { ...reportedMetrics, ...checked, ...(checked.modelUsage ? { modelUsage: { ...reportedMetrics.modelUsage, ...checked.modelUsage } } : {}) };
    observe("target.metrics", { ...metricsJson(next), provenance: "runner_reported" }); reportedMetrics = next;
  };
  let output: Json = null;
  // Adapter lifecycle facts, not customer metrics or returned fields. A
  // foreground timeout cannot prove an arbitrary promise or remote task stopped.
  let nativeStarted = false, nativeSettled = false, httpDispatched = false, httpResponseConfirmed = false;
  try {
    record(event("runner.prepared", { target: run.target.kind, isolation: "non_hermetic", attemptId,
      targetInvocationVersion: TARGET_INVOCATION_VERSION }));
    signal.throwIfAborted();
    if (run.target.kind === "command") {
      const selected = run.target;
      const environment: NodeJS.ProcessEnv = { ...process.env, FIREDRILL_INPUT_JSON: JSON.stringify(run.scenario.input), FIREDRILL_RUN_ID: run.id, FIREDRILL_ATTEMPT_ID: attemptId };
      // Operator authority never becomes a target-process binding.
      delete environment.FIREDRILL_CREDENTIAL; delete environment.FIREDRILL_TOKEN;
      delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN; delete environment.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete environment.FIREDRILL_CI_RESULT_DIRECTORY; delete environment.FIREDRILL_CI_REPORT;
      type CommandStop = { boundary: "owned_posix_process_group" | "windows_child_only"; state: "group_absent" | "unconfirmed"; leaderClosed: boolean };
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string; error?: string; stop?: CommandStop }>((resolve) => {
        let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), size = 0, failure: string | undefined;
        let stopping: Promise<void> | undefined, stopReceipt: CommandStop | undefined, closed = false, settled = false, code: number | null = null;
        const posix = process.platform !== "win32";
        const child = spawn(selected.argv[0]!, selected.argv.slice(1), { cwd: selected.cwd, shell: false, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: posix });
        child.once("spawn", () => events.push(event("runner.started", { target: "command", attemptId })));
        const finish = () => {
          if (settled) return;
          settled = true; signal.removeEventListener("abort", stop);
          if (!closed) {
            // Only release this adapter's own handles. A missed cleanup bound
            // is reported; it is not permission to scan or kill other processes.
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          }
          resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), error: failure, ...(stopReceipt ? { stop: stopReceipt } : {}) });
        };
        const groupAbsent = (): boolean | undefined => {
          if (!child.pid) return true;
          try { process.kill(-child.pid, 0); return false; }
          catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : undefined; }
        };
        const kill = (force = false) => {
          if (!child.pid) return;
          try { if (posix) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); else if (!closed) child.kill(force ? "SIGKILL" : "SIGTERM"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "Target termination could not be confirmed"; }
        };
        const stop = () => {
          if (stopping || settled) return;
          stopping = Promise.resolve().then(async () => {
            try {
              // Completion of the leader/pipes is not completion of this owned
              // process group. Reap remaining descendants on success too; a
              // group already observed absent needs no termination grace wait.
              if (!posix || groupAbsent() !== true) kill();
              const grace = Date.now() + 1000;
              while (Date.now() < grace && (posix ? groupAbsent() !== true : !closed)) await delay(25);
              if (!posix || groupAbsent() !== true) kill(true);
              const until = Date.now() + 1000;
              while (posix && groupAbsent() === false && Date.now() < until) await delay(25);
              stopReceipt = { boundary: posix ? "owned_posix_process_group" : "windows_child_only",
                state: posix && groupAbsent() === true ? "group_absent" : "unconfirmed", leaderClosed: closed };
              // Exit may precede delivery of the leader's final output. Drain
              // only these owned pipes under a separate, bounded cleanup wait.
              const drainUntil = Date.now() + 250;
              while (!closed && Date.now() < drainUntil) await delay(10);
              stopReceipt.leaderClosed = closed;
            } catch {
              stopReceipt = { boundary: posix ? "owned_posix_process_group" : "windows_child_only", state: "unconfirmed", leaderClosed: closed };
            } finally { finish(); }
          });
        };
        const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
          if (settled) return;
          const allowed = Math.max(0, limits.maxOutputBytes - size);
          const part = chunk.subarray(0, allowed); size += part.length;
          if (kind === "stdout") stdout = Buffer.concat([stdout, part]); else stderr = Buffer.concat([stderr, part]);
          if (part.length < chunk.length) { failure = "OUTPUT_LIMIT: command output exceeded maxOutputBytes; retained prefix only"; stop(); }
        };
        child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk)); child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.on("error", (error) => { failure = reason(error); });
        child.stdin.on("error", () => { /* Early target exit is reflected by exit status. */ });
        child.stdin.end(JSON.stringify(envelope));
        signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
        child.on("exit", (exitCode) => {
          code = exitCode;
          // A descendant can inherit a pipe after the leader has exited. Its
          // EOF is not the target's completion signal; cleanup owns that wait.
          clearTimeout(timer);
          stop();
        });
        child.on("close", (exitCode) => { closed = true; code = exitCode; stop(); });
      });
      // Redact before chunk boundaries can split a credential into two events.
      result.stdout = redactToolSecrets(result.stdout, tools);
      result.stderr = redactToolSecrets(result.stderr, tools);
      for (const [stream, text] of [["stdout", result.stdout], ["stderr", result.stderr]] as const) {
        if (!text.length) events.push(event(`runner.${stream}`, { text: "", offset: 0 }));
        for (let offset = 0; offset < text.length; offset += 16384) events.push(event(`runner.${stream}`, { text: text.slice(offset, offset + 16384), offset }));
      }
      events.push(event("runner.exit", { code: result.code }));
      if (result.stop) events.push(event("runner.command_stop", { ...result.stop, provenance: "adapter_observed", escapedDescendants: "not_observed" }));
      output = parse(result.stdout);
      if (Buffer.byteLength(JSON.stringify(output)) > limits.maxOutputBytes) { output = null; result.error = "OUTPUT_LIMIT: serialized result exceeded maxOutputBytes; bounded stream prefix retained as events"; }
      if (result.stop?.state === "unconfirmed") return { execution: "interrupted", output,
        reason: `${(result.error ?? (signal.aborted ? reason(signal.reason) : "Command stop requested")).slice(0, 3500)}; command descendant stop is unconfirmed; inspect the customer runner before more execution`,
        events, metrics: { durationMs: performance.now() - started }, stopUnconfirmed: true };
      if (signal.aborted) throw signal.reason;
      if (result.error || result.code !== 0) return { execution: "error", output, reason: result.error ?? `Command exited with status ${result.code}`, events, metrics: { durationMs: performance.now() - started } };
    } else if (run.target.kind === "http") {
      const url = new URL(run.target.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP_TARGET_INVALID: use HTTP(S) without embedded credentials");
      const body = JSON.stringify(envelope);
      signal.throwIfAborted();
      events.push(event("runner.http_dispatch", { method: run.target.method, attemptId }));
      httpDispatched = true;
      const response = await fetch(url, { method: run.target.method, headers: { "content-type": "application/json" }, body, signal, redirect: "manual" });
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { if (reader) for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > limits.maxOutputBytes) throw new Error("OUTPUT_LIMIT: HTTP output exceeded maxOutputBytes"); chunks.push(item.value); } }
      catch (error) {
        // Preserve only bytes actually received within the bound, explicitly as
        // an incomplete response. This is not a reconstructed target answer.
        const prefix = Buffer.concat(chunks).toString("utf8");
        output = parse(prefix);
        if (Buffer.byteLength(JSON.stringify(output)) > limits.maxOutputBytes) output = null;
        events.push(event("runner.http_partial", { status: response.status, retainedBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0), complete: false }));
        throw error;
      }
      finally { await reader?.cancel().catch(() => {}); }
      httpResponseConfirmed = true;
      output = parse(Buffer.concat(chunks).toString("utf8"));
      if (Buffer.byteLength(JSON.stringify(output)) > limits.maxOutputBytes) { output = null; throw new Error("OUTPUT_LIMIT: serialized HTTP result exceeded maxOutputBytes"); }
      events.push(event("runner.http", { status: response.status, bytes: size }));
      if (!response.ok) return { execution: "error", output, reason: `HTTP target returned ${response.status}; redirects are not followed`, events, metrics: { durationMs: performance.now() - started } };
    } else {
      if (!native) throw new Error("NATIVE_TARGET_REQUIRED: supply the native callback in this process");
      const call = Promise.resolve().then(() => {
        signal.throwIfAborted(); record(event("runner.started", { target: "native", attemptId }));
        nativeStarted = true;
        return native(envelope.input, { schemaVersion: TARGET_INVOCATION_VERSION,
          runId: run.id, attemptId, scenario: envelope.scenario, configuration: envelope.configuration,
          signal, deadline: new Date(Date.now() + limits.timeoutMs).toISOString(), attach, tools, observe, recordMetrics,
          ...(step ? { step: { ...step } } : {}) });
      }).then(value => { nativeSettled = true; return value; }, error => { nativeSettled = true; throw error; });
      let stop: (() => void) | undefined;
      try {
        output = jsonValue(await Promise.race([call, new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop(); })]), limits.maxOutputBytes);
      } finally { if (stop) signal.removeEventListener("abort", stop); }
      record(event("runner.native", { isolation: "non_hermetic", stopEnforcement: "cooperative" }));
    }
    return { execution: "completed", output, reason: null, events, metrics: { ...metricsJson(reportedMetrics), durationMs: performance.now() - started } };
  } catch (error) {
    const wrapperStopUnconfirmed = nativeStarted && targetStopUnconfirmed(error);
    const stopUnconfirmed = nativeStarted && !nativeSettled || wrapperStopUnconfirmed || httpDispatched && !httpResponseConfirmed;
    if (stopUnconfirmed) events.push(event("runner.target_stop", {
      target: run.target.kind, boundary: run.target.kind === "native" ? "native_cooperative" : "remote_http",
      state: "unconfirmed", provenance: "adapter_observed",
      dispatchAttempted: true, cancellationRequested: signal.aborted,
      ...(wrapperStopUnconfirmed ? { source: "native_adapter_error" } : {}),
    }));
    return { execution: stopUnconfirmed ? "interrupted" : signal.aborted ? aborted(signal) : "error", output,
      reason: reason(error) + (stopUnconfirmed
        ? run.target.kind === "native" ? "; native target or wrapper-owned work stop is unconfirmed; no further automatic target dispatch"
          : "; HTTP response and remote stop are unconfirmed; no further automatic target dispatch"
        : ""), events, metrics: { ...metricsJson(reportedMetrics), durationMs: performance.now() - started },
      ...(stopUnconfirmed ? { stopUnconfirmed: true as const } : {}) };
  } finally { observing = false; clearTimeout(timer); outer.removeEventListener("abort", onAbort); }
}

import { FiredrillError } from "./errors.js";

const AUTHORIZE = "https://api.workos.com/user_management/authorize/device";
const AUTHENTICATE = "https://api.workos.com/user_management/authenticate";
const BODY_BYTES = 64 * 1024, REQUEST_MS = 10_000;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
export class DeviceAuthorizationError extends FiredrillError {
  constructor(code: string, message: string, uncertain = false) {
    super(code, message, uncertain
      ? "Preserve the pending authentication intent. Do not blindly retry a possibly consumed refresh token; authorize again if its result cannot be recovered."
      : "Check the configured account and human authorization, then explicitly restart sign-in if needed. No new flow was started automatically.", { uncertain });
    this.name = "DeviceAuthorizationError";
  }
}
const error = (code: string, message: string, uncertain = false) => new DeviceAuthorizationError(code, message, uncertain);
const invalid = (uncertain = false) => error("FD_DEVICE_AUTH_INVALID_RESPONSE", "The identity provider returned an invalid response. No provider details were exposed.", uncertain);
function checkAbort(signal?: AbortSignal, uncertain = false) { if (signal?.aborted) throw error("FD_DEVICE_AUTH_CANCELLED", "Device authorization was cancelled.", uncertain); }
function text(value: unknown, min = 1, max = 8192): value is string { return typeof value === "string" && value.length >= min && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function clientId(value: string) { if (!/^client_[A-Za-z0-9_-]{1,128}$/.test(value)) throw error("FD_DEVICE_AUTH_CONFIGURATION", "A valid, explicitly configured identity client ID is required."); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(true); return value as Record<string, unknown>; }
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, failure: () => DeviceAuthorizationError): Promise<T> {
  if (signal.aborted) throw failure();
  let listener: (() => void) | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { listener = () => reject(failure()); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); })]); }
  finally { if (listener) signal.removeEventListener("abort", listener); }
}
async function sleep(ms: number, signal?: AbortSignal) {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(error("FD_DEVICE_AUTH_CANCELLED", "Device authorization was cancelled.")); };
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
export interface QualificationTiming { nowMs(): number; sleep(milliseconds: number, signal?: AbortSignal): Promise<void> }
interface Transport { signal?: AbortSignal; qualificationFetch?: typeof fetch }
async function request(url: typeof AUTHORIZE | typeof AUTHENTICATE, body: URLSearchParams, options: Transport, maximumMs = REQUEST_MS): Promise<{ status: number; body: Record<string, unknown> }> {
  checkAbort(options.signal);
  if (Buffer.byteLength(body.toString()) > 32 * 1024) throw invalid();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(REQUEST_MS, maximumMs)));
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const failure = () => options.signal?.aborted ? error("FD_DEVICE_AUTH_CANCELLED", "Device authorization was cancelled.", true)
    : error("FD_DEVICE_AUTH_TIMEOUT", "The identity request did not finish within its deadline.", true);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await raceAbort((options.qualificationFetch ?? globalThis.fetch)(url, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "accept-encoding": "identity" },
      body, credentials: "omit", redirect: "error", signal,
    }), signal, failure);
    const length = response.headers.get("content-length");
    if (response.redirected || response.status >= 300 && response.status < 400 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity" ||
      length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_BYTES) || !response.body) {
      void response.body?.cancel().catch(() => {}); throw invalid(true);
    }
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
    while (true) { const item = await raceAbort(reader.read(), signal, failure); if (item.done) break; count += item.value.byteLength; if (count > BODY_BYTES) throw invalid(true); chunks.push(item.value); }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalid(true); }
    return { status: response.status, body: object(parsed) };
  } catch (caught) {
    if (caught instanceof DeviceAuthorizationError) throw caught;
    if (signal.aborted) throw failure();
    throw error("FD_DEVICE_AUTH_TRANSPORT", "The identity request did not return a confirmed response.", true);
  } finally { clearTimeout(timer); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
}

/** Opaque transport result, not a verified identity. Secret export is deliberately explicit. */
export class ProviderTokens {
  #access: string;
  #refresh: string;
  constructor(access: string, refresh: string) { this.#access = access; this.#refresh = refresh; }
  accessToken() { return this.#access; }
  refreshToken() { return this.#refresh; }
  toJSON() { return { kind: "ProviderTokens", redacted: true }; }
  toString() { return "[ProviderTokens redacted]"; }
  [INSPECT]() { return this.toString(); }
}
function tokens(body: Record<string, unknown>): ProviderTokens {
  if (!text(body.access_token, 32) || !text(body.refresh_token, 16)) throw invalid(true);
  return new ProviderTokens(body.access_token, body.refresh_token);
}
export interface DevicePending {
  status: "pending" | "slow_down" | "transport_backoff";
  intervalSeconds: number;
  expiresAt: string;
}
export interface StartDeviceAuthorizationOptions extends Transport {
  clientId: string;
  verificationOrigin: string;
  /** Explicit protocol-fixture clock; ordinary callers use monotonic deadline accounting. */
  qualificationTiming?: QualificationTiming;
}
export class DeviceAuthorization {
  #code: string; #clientId: string; #fetch?: typeof fetch; #signal?: AbortSignal;
  #deadline: number; #now: () => number; #sleep: QualificationTiming["sleep"]; #interval: number;
  #public: { userCode: string; verificationUrl: string; expiresAt: string };
  #state: "ready" | "polling" | "closed" = "ready";
  constructor(secret: { code: string; clientId: string; deadline: number; interval: number; now: () => number; sleep: QualificationTiming["sleep"]; transport: Transport }, value: { userCode: string; verificationUrl: string; expiresAt: string }) {
    this.#code = secret.code; this.#clientId = secret.clientId; this.#deadline = secret.deadline; this.#interval = secret.interval; this.#now = secret.now; this.#sleep = secret.sleep;
    this.#fetch = secret.transport.qualificationFetch; this.#signal = secret.transport.signal; this.#public = { ...value };
  }
  toJSON() { return { ...this.#public }; }
  toString() { return JSON.stringify(this.toJSON()); }
  [INSPECT]() { return this.toJSON(); }
  async poll(options: { signal?: AbortSignal; onPending?: (value: DevicePending) => void | Promise<void> } = {}): Promise<ProviderTokens> {
    if (this.#state !== "ready") throw error("FD_DEVICE_AUTH_ATTEMPT_CLOSED", "This device attempt is already polling or closed. It cannot be polled twice.");
    this.#state = "polling";
    const signals = [this.#signal, options.signal].filter((value): value is AbortSignal => Boolean(value));
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    let uncertain = false;
    try {
      while (this.#now() < this.#deadline) {
        checkAbort(signal, uncertain);
        await this.#sleep(Math.min(this.#interval * 1000, this.#deadline - this.#now()), signal);
        if (this.#now() >= this.#deadline) break;
        let response: Awaited<ReturnType<typeof request>>;
        try { response = await request(AUTHENTICATE, new URLSearchParams({ client_id: this.#clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: this.#code }), { signal, qualificationFetch: this.#fetch }, this.#deadline - this.#now()); }
        catch (caught) {
          if (!(caught instanceof DeviceAuthorizationError) || !["FD_DEVICE_AUTH_TIMEOUT", "FD_DEVICE_AUTH_TRANSPORT"].includes(caught.code)) throw caught;
          uncertain = true; this.#interval *= 2;
          await this.#notify(options.onPending, "transport_backoff", signal); continue;
        }
        if (this.#now() >= this.#deadline) { uncertain ||= response.status === 200; break; }
        checkAbort(signal, true);
        if (response.status === 200) return tokens(response.body);
        if (response.status === 400 && response.body.error === "authorization_pending") { await this.#notify(options.onPending, "pending", signal); continue; }
        if (response.status === 400 && response.body.error === "slow_down") { this.#interval += 5; await this.#notify(options.onPending, "slow_down", signal); continue; }
        if (response.status === 400 && response.body.error === "access_denied") throw error("FD_DEVICE_AUTH_DENIED", "The human declined this device authorization.");
        if (response.status === 400 && response.body.error === "expired_token") throw error("FD_DEVICE_AUTH_EXPIRED", "This device authorization has expired.", uncertain);
        throw error("FD_DEVICE_AUTH_REJECTED", "The identity provider did not approve this device authorization.", uncertain || response.status >= 500);
      }
      throw error("FD_DEVICE_AUTH_EXPIRED", "This device authorization has expired.", uncertain);
    } catch (caught) {
      if (caught instanceof DeviceAuthorizationError) throw uncertain && !caught.details.uncertain ? error(caught.code, caught.message, true) : caught;
      checkAbort(signal, uncertain); throw error("FD_DEVICE_AUTH_INTERRUPTED", "The device authorization could not continue.", uncertain);
    } finally { this.#state = "closed"; this.#code = ""; }
  }
  async #notify(callback: ((value: DevicePending) => void | Promise<void>) | undefined, status: DevicePending["status"], signal?: AbortSignal) {
    if (!callback) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(REQUEST_MS, this.#deadline - this.#now())));
    try {
      await raceAbort(Promise.resolve().then(() => callback({ status, intervalSeconds: this.#interval, expiresAt: this.#public.expiresAt })), signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        () => error(signal?.aborted ? "FD_DEVICE_AUTH_CANCELLED" : "FD_DEVICE_AUTH_OBSERVER_TIMEOUT", "Device authorization progress handling was interrupted."));
    } finally { clearTimeout(timer); }
  }
}
export async function startDeviceAuthorization(options: StartDeviceAuthorizationOptions): Promise<DeviceAuthorization> {
  clientId(options.clientId); checkAbort(options.signal);
  let origin: URL;
  try { origin = new URL(options.verificationOrigin); } catch { throw error("FD_DEVICE_AUTH_CONFIGURATION", "An exact configured HTTPS verification origin is required."); }
  if (origin.protocol !== "https:" || origin.origin !== options.verificationOrigin || origin.username || origin.password || origin.port || !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(origin.hostname) || origin.hostname.endsWith(".localhost") || origin.hostname.endsWith(".local")) throw error("FD_DEVICE_AUTH_CONFIGURATION", "An exact configured HTTPS verification origin is required.");
  const now = options.qualificationTiming?.nowMs ?? (() => performance.now()), wait = options.qualificationTiming?.sleep ?? sleep;
  const began = now(), wall = options.qualificationTiming?.nowMs() ?? Date.now();
  if (!Number.isFinite(began) || !integer(wall, 0, 8_640_000_000_000_000 - 1_800_000)) throw error("FD_DEVICE_AUTH_CONFIGURATION", "The protocol-fixture clock is invalid.");
  const response = await request(AUTHORIZE, new URLSearchParams({ client_id: options.clientId }), options);
  if (response.status !== 200) throw error("FD_DEVICE_AUTH_START_REJECTED", "The identity provider could not begin device authorization.");
  const body = response.body;
  if (!text(body.device_code, 32) || !text(body.user_code, 4, 32) || !/^[A-Za-z0-9-]+$/.test(body.user_code) || !integer(body.expires_in, 1, 1800) || body.interval !== undefined && !integer(body.interval, 1, 60) || body.verification_uri !== `${origin.origin}/device`) throw invalid();
  let verificationUrl = body.verification_uri;
  if (body.verification_uri_complete !== undefined) {
    let complete: URL;
    try { complete = new URL(String(body.verification_uri_complete)); } catch { throw invalid(); }
    if (!text(body.verification_uri_complete, 1, 2048) || complete.origin !== origin.origin || complete.username || complete.password || complete.hash || complete.pathname !== "/device" || complete.searchParams.size !== 1 || complete.searchParams.get("user_code") !== body.user_code) throw invalid();
    verificationUrl = complete.href;
  }
  return new DeviceAuthorization({ code: body.device_code, clientId: options.clientId, deadline: began + body.expires_in * 1000, interval: body.interval as number | undefined ?? 5, now, sleep: wait, transport: options }, { userCode: body.user_code, verificationUrl, expiresAt: new Date(wall + body.expires_in * 1000).toISOString() });
}
export interface RefreshProviderTokensOptions extends Transport {
  clientId: string;
  refreshToken: string;
  /** Explicit user selection, validated again by the provider and control service. */
  organizationId?: string;
  /** Must durably mark the caller's exact saved refresh intent before any consuming request. */
  beforeRefresh: () => void | Promise<void>;
}
export async function refreshProviderTokens(options: RefreshProviderTokensOptions): Promise<ProviderTokens> {
  clientId(options.clientId); checkAbort(options.signal);
  if (options.organizationId !== undefined && !/^org_[A-Za-z0-9_-]{1,128}$/.test(options.organizationId)) throw error("FD_DEVICE_AUTH_CONFIGURATION", "The selected organization identifier is invalid.");
  if (!text(options.refreshToken, 16) || typeof options.beforeRefresh !== "function") throw error("FD_DEVICE_AUTH_REFRESH_INTENT_REQUIRED", "A protected refresh token and durable beforeRefresh callback are required.");
  try { await options.beforeRefresh(); } catch { throw error("FD_DEVICE_AUTH_REFRESH_INTENT_REQUIRED", "The refresh intent was not confirmed; no refresh request was sent."); }
  checkAbort(options.signal);
  // Exactly one request: a lost response may have consumed/rotated the original token.
  const response = await request(AUTHENTICATE, new URLSearchParams({ client_id: options.clientId, grant_type: "refresh_token", refresh_token: options.refreshToken,
    ...(options.organizationId ? { organization_id: options.organizationId } : {}) }), options);
  checkAbort(options.signal, true);
  if (response.status === 200) return tokens(response.body);
  if (response.status === 400 && response.body.error === "invalid_grant") throw error("FD_DEVICE_AUTH_REFRESH_EXPIRED", "The protected login can no longer be refreshed. Human authorization is required.");
  throw error("FD_DEVICE_AUTH_REFRESH_REJECTED", "Refresh did not return a confirmed replacement token.", true);
}

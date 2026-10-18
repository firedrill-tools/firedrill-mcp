import { randomUUID } from "node:crypto";
import { FiredrillError } from "./errors.js";
import { resolveApiUrl } from "./api-origin.js";
import { LoginStore } from "./login-store.js";
import { startDeviceAuthorization, refreshProviderTokens, type QualificationTiming } from "./device-authorization.js";

const VERSION = "2026-10-14-login.1" as const;
const ONBOARDING_VERSION = "2026-10-14-onboarding.1" as const;
export interface LoginOrganizations {
  schemaVersion: typeof ONBOARDING_VERSION;
  defaultOrganizationName: string;
  organizations: Array<{ organizationId: string; name: string; status: "active" | "pending" }>;
  canCreate: boolean;
  continuation?: string;
  invitationPending?: boolean;
  retainedSetup?: { name: string; phase: "organization_pending" | "membership_pending" | "complete"; organizationId: string | null };
}
export type LoginOrganizationChoice = { organizationId: string } | { name: string };
interface Configuration { schemaVersion: typeof VERSION; provider: "workos"; clientId: string; verificationOrigin: string }
export interface LoginCredential { id: string; organizationId: string; expiresAt: string; capabilities: string[] }
export interface LoginStatus { apiUrl: string; source: "protected_login"; signedIn: boolean; credential?: LoginCredential }
export interface LoginOptions {
  /** @deprecated Production is automatic. Alternate service addresses are rejected. */
  apiUrl?: string;
  /** Owner-only local state outside every repository. Defaults to ~/.local/state/firedrill/login. */
  storeDirectory?: string;
  /** Explicit protocol qualification only. Normal clients always use the fixed provider endpoints. */
  qualification?: { providerFetch?: typeof fetch; timing?: QualificationTiming };
}
export interface LoginAction {
  onVerification: (value: { verificationUrl: string; userCode: string; expiresAt: string }) => void | Promise<void>;
  signal?: AbortSignal;
  /** One explicit replay of an uncertain refresh, dispatched less than 25 seconds after its saved intent. */
  retryPendingRefresh?: boolean;
  /** Deliberately replace an unrecoverable login only after a new provider receipt has been saved. */
  reauthorize?: boolean;
  /** Human-visible choice only. SDK token resolution never creates an organization. */
  onOrganization?: (value: LoginOrganizations) => Promise<LoginOrganizationChoice>;
}
interface State {
  schemaVersion: typeof VERSION; apiUrl: string; configuration: Configuration;
  phase: "exchange_pending" | "ready" | "refresh_pending" | "renew_pending" | "logout_pending" | "reauthorization_required";
  provider: { accessToken: string; refreshToken: string };
  exchangeKey: string; credential?: LoginCredential; token?: string;
  refreshIntent?: { id: string; startedAt: number; attempts: number };
  onboarding?: { phase: "create_pending"; name: string; key: string } | { phase: "selected" | "refreshed"; organizationId: string };
}
const authRequired = () => new FiredrillError("AUTH_REQUIRED", "No protected Firedrill sign-in is available for this API origin.", "A human can run firedrill login in an interactive terminal, or provide an authorized FIREDRILL_TOKEN. SDK calls never open a browser.");
const invalid = () => new FiredrillError("FD_LOGIN_INVALID_RESPONSE", "Sign-in returned an invalid bounded response.", "Preserve protected state and recover the same login intent. No response content was exposed.", { uncertain: true });
const pending = () => new FiredrillError("FD_LOGIN_REFRESH_PENDING", "The previous refresh result is uncertain; it was not repeated.", "Within 25 seconds, a human may explicitly run firedrill login --retry-refresh once. Otherwise use firedrill login --reauthorize. Protected state was preserved.", { uncertain: true });
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>; };
const string = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
export const loginApiOrigin = resolveApiUrl;
function configuration(value: unknown): Configuration {
  const item = object(value);
  if (item.schemaVersion !== VERSION || item.provider !== "workos" || !string(item.clientId, 136) || !/^client_[A-Za-z0-9_-]{1,128}$/.test(item.clientId) || !string(item.verificationOrigin, 2048)) throw invalid();
  let url: URL; try { url = new URL(item.verificationOrigin); } catch { throw invalid(); }
  if (url.origin !== item.verificationOrigin || url.protocol !== "https:" || url.port || url.username || url.password || !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/.test(url.hostname) || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw invalid();
  return { schemaVersion: VERSION, provider: "workos", clientId: item.clientId, verificationOrigin: item.verificationOrigin };
}
function credential(value: unknown): LoginCredential {
  const item = object(value);
  if (!string(item.id, 128) || !/^cred_[a-f0-9]{24}$/.test(item.id) || !string(item.organizationId, 128) || !/^org_[a-f0-9]{24}$/.test(item.organizationId) || !string(item.expiresAt, 64) || !Number.isFinite(Date.parse(item.expiresAt)) || !Array.isArray(item.capabilities) || item.capabilities.length > 100 || item.capabilities.some(value => !string(value, 100) || !/^[a-z][a-z0-9_.:-]*$/.test(value))) throw invalid();
  return { id: item.id, organizationId: item.organizationId, expiresAt: item.expiresAt, capabilities: [...item.capabilities] as string[] };
}
function organizationId(value: unknown): value is string { return typeof value === "string" && /^org_[A-Za-z0-9_-]{1,128}$/.test(value); }
function organizationName(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value); }
function organizations(value: unknown): LoginOrganizations {
  const item = object(value);
  if (item.schemaVersion !== ONBOARDING_VERSION || !organizationName(item.defaultOrganizationName) || typeof item.canCreate !== "boolean" || !Array.isArray(item.organizations) || item.organizations.length > 100) throw invalid();
  const entries = item.organizations.map(value => { const entry = object(value); if (!organizationId(entry.organizationId) || !organizationName(entry.name) || !["active", "pending"].includes(String(entry.status))) throw invalid(); return { organizationId: entry.organizationId, name: entry.name, status: entry.status as "active" | "pending" }; });
  if (new Set(entries.map(entry => entry.organizationId)).size !== entries.length || item.canCreate && entries.length > 0) throw invalid();
  if (item.continuation !== undefined && !string(item.continuation, 128)) throw invalid();
  if (item.invitationPending !== undefined && typeof item.invitationPending !== "boolean") throw invalid();
  let retainedSetup: LoginOrganizations["retainedSetup"];
  if (item.retainedSetup !== undefined) {
    const retained = object(item.retainedSetup);
    if (!organizationName(retained.name) || !["organization_pending", "membership_pending", "complete"].includes(String(retained.phase)) || retained.organizationId !== null && !organizationId(retained.organizationId) || item.canCreate) throw invalid();
    retainedSetup = { name: retained.name, phase: retained.phase as NonNullable<LoginOrganizations["retainedSetup"]>["phase"], organizationId: retained.organizationId as string | null };
  }
  return { schemaVersion: ONBOARDING_VERSION, defaultOrganizationName: item.defaultOrganizationName, organizations: entries, canCreate: item.canCreate,
    ...(item.continuation ? { continuation: item.continuation as string } : {}), ...(item.invitationPending !== undefined ? { invitationPending: item.invitationPending } : {}), ...(retainedSetup ? { retainedSetup } : {}) };
}
function state(value: unknown, apiUrl: string): State | undefined {
  if (value === undefined) return undefined;
  try {
    const item = object(value), provider = object(item.provider);
    if (item.schemaVersion !== VERSION || item.apiUrl !== apiUrl || !["exchange_pending", "ready", "refresh_pending", "renew_pending", "logout_pending", "reauthorization_required"].includes(String(item.phase)) || !string(provider.accessToken) || !string(provider.refreshToken) || !string(item.exchangeKey, 200)) throw invalid();
    const result: State = { schemaVersion: VERSION, apiUrl, configuration: configuration(item.configuration), phase: item.phase as State["phase"], provider: { accessToken: provider.accessToken, refreshToken: provider.refreshToken }, exchangeKey: item.exchangeKey };
    if (item.credential !== undefined || item.token !== undefined) { result.credential = credential(item.credential); if (!string(item.token, 128) || !/^fd_login_[A-Za-z0-9_-]{43}$/.test(item.token)) throw invalid(); result.token = item.token; }
    if (["ready", "renew_pending", "logout_pending"].includes(result.phase) && !result.token) throw invalid();
    if (item.refreshIntent !== undefined) { const intent = object(item.refreshIntent); if (!string(intent.id, 128) || !Number.isSafeInteger(intent.startedAt) || Number(intent.startedAt) < 0 || ![1, 2].includes(Number(intent.attempts))) throw invalid(); result.refreshIntent = { id: intent.id, startedAt: Number(intent.startedAt), attempts: Number(intent.attempts) }; }
    if (result.phase === "refresh_pending" && !result.refreshIntent) throw invalid();
    if (item.onboarding !== undefined) {
      const pending = object(item.onboarding);
      if (pending.phase === "create_pending" && organizationName(pending.name) && string(pending.key, 200)) result.onboarding = { phase: "create_pending", name: pending.name, key: pending.key };
      else if (["selected", "refreshed"].includes(String(pending.phase)) && organizationId(pending.organizationId)) result.onboarding = { phase: pending.phase as "selected" | "refreshed", organizationId: pending.organizationId };
      else throw invalid();
      if (result.credential) throw invalid();
    }
    return result;
  } catch { throw new FiredrillError("FD_LOGIN_STORE_INVALID", "Protected sign-in state is invalid or belongs to another origin.", "Do not copy credentials between origins or edit a pending state file. Restore the exact protected state or use a separate protected directory."); }
}
async function request(apiUrl: string, path: string, options: { token?: string; body?: unknown; key?: string; signal?: AbortSignal } = {}): Promise<unknown> {
  if (options.signal?.aborted) throw new FiredrillError("FD_LOGIN_CANCELLED", "Sign-in was cancelled before dispatch.", "Protected state was preserved.");
  const timeout = path === "/v1/auth/onboarding" ? 30_000 : 10_000;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${apiUrl}${path}`, { method: options.body === undefined ? "GET" : "POST", headers: { accept: "application/json", "accept-encoding": "identity", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...(options.key ? { "Idempotency-Key": options.key } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal, redirect: "error", credentials: "omit" });
    if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity" || !response.body) { void response.body?.cancel().catch(() => {}); throw invalid(); }
    const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) { void response.body.cancel().catch(() => {}); throw invalid(); }
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
    for (;;) { const item = await reader.read(); if (item.done) break; count += item.value.byteLength; if (count > 65536) throw invalid(); chunks.push(item.value); }
    const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    if (!response.ok) {
      const code = object(value.error).code;
      const known = ["FD_LOGIN_RECOVERY_EXPIRED", "FD_LOGIN_INACTIVE", "FD_LOGIN_ACCESS_DENIED", "FD_LOGIN_REQUIRED", "FD_IDENTITY_UNAVAILABLE", "FD_LOGIN_CONFIGURATION", "FD_IDENTITY_ORGANIZATION_REQUIRED", "FD_IDENTITY_MEMBERSHIP_REQUIRED", "FD_IDENTITY_EXPIRED", "FD_LOGIN_ORGANIZATION_MISMATCH", "FD_ONBOARDING_RECONCILIATION_REQUIRED", "FD_ONBOARDING_MEMBERSHIP_REMOVED", "FD_ONBOARDING_EMAIL_REQUIRED", "FD_ONBOARDING_ORGANIZATION_EXISTS", "FD_ONBOARDING_CREATION_UNAVAILABLE", "FD_ONBOARDING_IN_PROGRESS", "FD_ONBOARDING_SESSION_INACTIVE", "FD_ONBOARDING_UNAVAILABLE", "FD_ONBOARDING_PROVIDER_INVALID", "FD_ONBOARDING_BOUND"];
      const repair = code === "FD_ONBOARDING_RECONCILIATION_REQUIRED" ? "Keep the protected setup state and contact support to reconcile the original creation. Do not create a replacement organization."
        : code === "FD_ONBOARDING_MEMBERSHIP_REMOVED" ? "Ask your organization administrator to restore access. This login will not reactivate removed membership."
        : code === "FD_ONBOARDING_EMAIL_REQUIRED" ? "Verify your email in WorkOS, then run firedrill login again."
        : code === "FD_LOGIN_ORGANIZATION_MISMATCH" ? "The provider returned a different organization from your selection. No access was issued; complete sign-in for the selected organization."
        : response.status === 401 || response.status === 403 ? "Check account authorization. Explicitly sign in again if the saved session is inactive; machine credentials are separate."
        : "Preserve protected state and retry only the same saved action after service recovery.";
      throw new FiredrillError(typeof code === "string" && known.includes(code) ? code : "FD_LOGIN_REJECTED", "The selected Firedrill service did not confirm this authentication action.", repair, { status: response.status, uncertain: response.status >= 500 || response.status === 429 });
    }
    return value;
  } catch (error) {
    if (error instanceof FiredrillError) throw error;
    throw new FiredrillError("FD_LOGIN_TRANSPORT_UNCERTAIN", "The authentication response could not be confirmed.", "Protected state was preserved. Recover the same saved action; do not delete credentials because the service is offline.", { uncertain: options.body !== undefined });
  } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
}

/** Human-approved sign-in management. No browser is launched by this SDK. */
export class FiredrillLogin {
  readonly #apiUrl: string;
  get apiUrl(): string { return this.#apiUrl; }
  readonly #options: LoginOptions;
  readonly #store: LoginStore;
  constructor(options: LoginOptions = {}) { this.#apiUrl = loginApiOrigin(options.apiUrl); this.#options = options; this.#store = new LoginStore(this.apiUrl, options.storeDirectory); }
  #now() { return this.#options.qualification?.timing?.nowMs() ?? Date.now(); }
  async #configuration(saved: State | undefined, signal?: AbortSignal) {
    const current = configuration(await request(this.apiUrl, "/v1/auth/config", { signal }));
    if (saved && JSON.stringify(current) !== JSON.stringify(saved.configuration)) throw new FiredrillError("FD_LOGIN_CONFIGURATION_CHANGED", "The sign-in configuration no longer matches the saved session.", "Stop and verify the selected API/provider configuration with its operator. No saved credential or provider token was sent.");
    return current;
  }
  async #exchange(saved: State, signal?: AbortSignal) {
    const value = object(await request(this.apiUrl, "/v1/auth/exchange", { token: saved.provider.accessToken, body: { schemaVersion: VERSION, client: "cli",
      ...(saved.onboarding?.phase === "refreshed" ? { organizationId: saved.onboarding.organizationId } : {}) }, key: saved.exchangeKey, signal }));
    const metadata = credential(value.credential);
    if (!string(value.token, 128) || !/^fd_login_[A-Za-z0-9_-]{43}$/.test(value.token)) throw invalid();
    saved.credential = metadata; saved.token = value.token; saved.phase = "ready"; delete saved.refreshIntent; delete saved.onboarding; this.#store.write(saved);
  }
  async #renew(saved: State, signal?: AbortSignal) {
    const value = object(await request(this.apiUrl, "/v1/auth/renew", { token: saved.provider.accessToken, body: { schemaVersion: VERSION, credentialId: saved.credential!.id }, signal }));
    const metadata = credential(value.credential);
    if (metadata.id !== saved.credential!.id || metadata.organizationId !== saved.credential!.organizationId) throw invalid();
    saved.credential = metadata; saved.phase = "ready"; delete saved.refreshIntent; this.#store.write(saved);
  }
  async #refresh(saved: State, retry: boolean, signal?: AbortSignal) {
    if (saved.phase === "refresh_pending") {
      const intent = saved.refreshIntent!, elapsed = this.#now() - intent.startedAt;
      if (!retry || intent.attempts !== 1 || elapsed < 0 || elapsed >= 25_000) throw pending();
      intent.attempts = 2;
    } else { saved.refreshIntent = { id: randomUUID(), startedAt: this.#now(), attempts: 1 }; saved.phase = "refresh_pending"; }
    try {
      const tokens = await refreshProviderTokens({ clientId: saved.configuration.clientId, refreshToken: saved.provider.refreshToken,
        ...(saved.onboarding?.phase === "selected" ? { organizationId: saved.onboarding.organizationId } : {}), signal, qualificationFetch: this.#options.qualification?.providerFetch, beforeRefresh: () => {
        this.#store.write(saved);
        // A slow disk write must not turn an explicit short-window replay into a late one.
        if (saved.refreshIntent!.attempts === 2) { const elapsed = this.#now() - saved.refreshIntent!.startedAt; if (elapsed < 0 || elapsed >= 25_000) throw pending(); }
      } });
      saved.provider = { accessToken: tokens.accessToken(), refreshToken: tokens.refreshToken() };
      if (saved.onboarding?.phase === "selected") saved.onboarding.phase = "refreshed";
      saved.phase = saved.credential ? "renew_pending" : "exchange_pending";
      delete saved.refreshIntent; this.#store.write(saved); // New rotating tokens precede every service exchange/renewal.
    } catch (error) {
      if (error instanceof FiredrillError && error.code === "FD_DEVICE_AUTH_REFRESH_EXPIRED") { saved.phase = "reauthorization_required"; this.#store.write(saved); }
      throw error;
    }
  }
  async #onboard(saved: State, action: LoginAction) {
    if (!saved.onboarding) {
      const available = organizations(await request(this.apiUrl, "/v1/auth/onboarding", { token: saved.provider.accessToken, signal: action.signal }));
      if (!action.onOrganization) throw new FiredrillError("FD_LOGIN_ORGANIZATION_REQUIRED", "Choose your organization to finish sign-in.", "Run firedrill login in an interactive terminal. No organization was created or selected automatically.");
      const choice = object(await action.onOrganization(available));
      if (Object.keys(choice).length !== 1) throw invalid();
      if (organizationId(choice.organizationId) && available.organizations.some(item => item.organizationId === choice.organizationId && item.status === "active")) saved.onboarding = { phase: "selected", organizationId: choice.organizationId };
      else if (organizationName(choice.name) && available.canCreate) saved.onboarding = { phase: "create_pending", name: choice.name, key: randomUUID() };
      else throw new FiredrillError("FD_LOGIN_ORGANIZATION_UNAVAILABLE", "That organization choice is not available to this signed-in account.", "Accept a pending invitation or verify your email through WorkOS, then sign in again. No access was granted.");
      this.#store.write(saved);
    }
    if (saved.onboarding.phase === "create_pending") {
      const created = object(await request(this.apiUrl, "/v1/auth/onboarding", { token: saved.provider.accessToken,
        body: { schemaVersion: ONBOARDING_VERSION, name: saved.onboarding.name }, key: saved.onboarding.key, signal: action.signal }));
      if (created.schemaVersion !== ONBOARDING_VERSION || !organizationId(created.organizationId) || created.continuation !== "refresh_with_organization") throw invalid();
      saved.onboarding = { phase: "selected", organizationId: created.organizationId }; this.#store.write(saved);
    }
    if (saved.onboarding.phase === "selected") await this.#refresh(saved, false, action.signal);
    await this.#exchange(saved, action.signal);
  }
  async #completeLogin(saved: State, action: LoginAction, refreshedExpiredIdentity = false): Promise<void> {
    // An interrupted organization intent can only be continued by this explicit
    // login action, never by an SDK request or CI credential resolver.
    try {
      if (saved.onboarding && saved.phase !== "refresh_pending") { await this.#onboard(saved, action); return; }
      await this.#resolve(saved, action.retryPendingRefresh, action.signal);
    }
    catch (error) {
      if (error instanceof FiredrillError && error.code === "FD_IDENTITY_EXPIRED" && !refreshedExpiredIdentity && saved.phase !== "refresh_pending") {
        // Keep the original organization name/key across a slow or interrupted
        // setup. Refresh only a confirmed expired identity, never an uncertain
        // rotating-token request, and do not start another device authorization.
        await this.#refresh(saved, false, action.signal);
        await this.#completeLogin(saved, action, true); return;
      }
      if (!(error instanceof FiredrillError) || error.code !== "FD_IDENTITY_ORGANIZATION_REQUIRED" || saved.credential) throw error;
      await this.#onboard(saved, action);
    }
  }
  async #resolve(saved: State, retry = false, signal?: AbortSignal): Promise<State> {
    if (saved.phase === "logout_pending") throw new FiredrillError("FD_LOGIN_LOGOUT_PENDING", "A sign-out acknowledgement is pending.", "Run firedrill logout again to reconcile the same session. No target request was sent.", { uncertain: true });
    if (saved.phase === "reauthorization_required") throw new FiredrillError("AUTH_ACTION_REQUIRED", "This saved sign-in needs human authorization again.", "Run firedrill login in an interactive terminal. No new device flow was started automatically.");
    if (saved.phase === "refresh_pending") await this.#refresh(saved, retry, signal);
    if (saved.phase === "exchange_pending") await this.#exchange(saved, signal);
    if (saved.phase === "renew_pending") await this.#renew(saved, signal);
    if (Date.parse(saved.credential!.expiresAt) <= this.#now() + 30_000) { await this.#refresh(saved, false, signal); await this.#renew(saved, signal); }
    return saved;
  }
  async login(action: LoginAction, confirmCredential?: (credential?: LoginCredential) => void): Promise<LoginStatus> {
    if (typeof action.onVerification !== "function") throw new FiredrillError("AUTH_ACTION_REQUIRED", "Sign-in requires an explicit human verification handler.", "Use an interactive CLI terminal; SDK requests never start device authorization.");
    if (action.retryPendingRefresh && action.reauthorize) throw new FiredrillError("ARGUMENT_INVALID", "Choose refresh recovery or new human authorization, not both.", "Use one explicit action.");
    return this.#store.locked(async () => {
      let saved = state(this.#store.read(), this.apiUrl);
      confirmCredential?.(saved?.credential);
      const current = await this.#configuration(saved, action.signal);
      if (saved && !action.reauthorize && saved.phase !== "reauthorization_required") {
        await this.#completeLogin(saved, action);
      } else {
        if (action.retryPendingRefresh) throw pending();
        const attempt = await startDeviceAuthorization({ clientId: current.clientId, verificationOrigin: current.verificationOrigin, signal: action.signal, qualificationFetch: this.#options.qualification?.providerFetch, qualificationTiming: this.#options.qualification?.timing });
        const observerSignal = action.signal ? AbortSignal.any([action.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
        let cancelObserver: (() => void) | undefined;
        try {
          await Promise.race([Promise.resolve().then(() => action.onVerification(attempt.toJSON())), new Promise<never>((_resolve, reject) => {
            cancelObserver = () => reject(new FiredrillError("FD_LOGIN_OBSERVER_INTERRUPTED", "Human verification display was interrupted.", "No new provider receipt replaced protected state. Explicitly start sign-in again when ready."));
            observerSignal.addEventListener("abort", cancelObserver, { once: true }); if (observerSignal.aborted) cancelObserver();
          })]);
        } finally { if (cancelObserver) observerSignal.removeEventListener("abort", cancelObserver); }
        const tokens = await attempt.poll({ signal: action.signal });
        saved = { schemaVersion: VERSION, apiUrl: this.apiUrl, configuration: current, phase: "exchange_pending", provider: { accessToken: tokens.accessToken(), refreshToken: tokens.refreshToken() }, exchangeKey: randomUUID() };
        this.#store.write(saved); // Provider receipt and exact exchange identity are durable before dispatch.
        await this.#completeLogin(saved, action);
      }
      confirmCredential?.(saved.credential);
      return this.#confirmedStatus(saved, action.signal);
    }, action.signal);
  }
  #status(saved?: State): LoginStatus { return { apiUrl: this.apiUrl, source: "protected_login", signedIn: Boolean(saved?.credential), ...(saved?.credential ? { credential: { ...saved.credential, capabilities: [...saved.credential.capabilities] } } : {}) }; }
  async #confirmedStatus(saved: State, signal?: AbortSignal): Promise<LoginStatus> {
    const context = object(await request(this.apiUrl, "/v1/context", { token: saved.token, signal }));
    const principal = object(context.principal);
    if (principal.id !== saved.credential!.id || principal.organizationId !== saved.credential!.organizationId || !Array.isArray(principal.capabilities) || principal.capabilities.some(item => !string(item, 100))) throw invalid();
    const status = this.#status(saved);
    // Saved issuance metadata is not current authorization after a membership/role change.
    status.credential!.capabilities = saved.credential!.capabilities.filter(item => (principal.capabilities as string[]).includes(item));
    return status;
  }
  async status(confirmCredential?: (credential?: LoginCredential) => void): Promise<LoginStatus> {
    return this.#store.locked(async () => {
      let saved = state(this.#store.read(), this.apiUrl);
      confirmCredential?.(saved?.credential); if (!saved) return this.#status();
      await this.#configuration(saved); saved = await this.#resolve(saved);
      confirmCredential?.(saved.credential);
      return this.#confirmedStatus(saved);
    });
  }
  async logout(): Promise<{ apiUrl: string; signedOut: boolean; machineCredentialsRevoked: false }> {
    return this.#store.locked(async () => {
      const saved = state(this.#store.read(), this.apiUrl);
      if (!saved) return { apiUrl: this.apiUrl, signedOut: false, machineCredentialsRevoked: false };
      await this.#configuration(saved);
      if (!saved.token) {
        try { await this.#exchange(saved); }
        catch (error) {
          // An organization-less approved identity cannot have issued this
          // exchange. Let a person abandon that unfinished sign-in without
          // forcing organization creation. Never forget an uncertain exchange,
          // an expired identity, or an issued credential whose reply was lost.
          if (!(error instanceof FiredrillError) || error.code !== "FD_IDENTITY_ORGANIZATION_REQUIRED") throw error;
          this.#store.clear();
          return { apiUrl: this.apiUrl, signedOut: true, machineCredentialsRevoked: false };
        }
      }
      saved.phase = "logout_pending"; this.#store.write(saved);
      const value = object(await request(this.apiUrl, "/v1/auth/logout", { token: saved.token, body: {} }));
      if (value.signedOut !== true || value.machineCredentialsRevoked !== false) throw invalid();
      this.#store.clear(); return { apiUrl: this.apiUrl, signedOut: true, machineCredentialsRevoked: false };
    });
  }
  /** Internal SDK resolver. Its return value must only enter an Authorization header. */
  async resolveToken(confirmCredential?: (credential?: LoginCredential) => void): Promise<string> {
    return this.#store.locked(async () => {
      const saved = state(this.#store.read(), this.apiUrl); if (!saved) throw authRequired();
      // An SDK may pin its first identity. Check under the same durable lock
      // before refreshing/exchanging any replacement, then bind the exact token
      // returned by resolution. Ordinary CLI/MCP callers retain their contract.
      confirmCredential?.(saved.credential);
      await this.#configuration(saved); const resolved = await this.#resolve(saved);
      confirmCredential?.(resolved.credential); return resolved.token!;
    });
  }
  toJSON() { return { kind: "FiredrillLogin", apiUrl: this.apiUrl, redacted: true }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return this.toJSON(); }
}

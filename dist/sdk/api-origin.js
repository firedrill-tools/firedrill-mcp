import { FiredrillError } from "./errors.js";
/** Public clients have one service destination; this is not an authorization boundary. */
export const FIREDRILL_API_ORIGIN = "https://api.firedrill.run";
export function normalizeApiUrl(value) {
    if (value === undefined)
        return FIREDRILL_API_ORIGIN;
    // Accept only the former canonical setting, never silently move a dev selection
    // or its saved operation to production. Avoid URL parser normalization surprises.
    if (value === FIREDRILL_API_ORIGIN || value === `${FIREDRILL_API_ORIGIN}/`)
        return FIREDRILL_API_ORIGIN;
    throw new FiredrillError("FD_API_ENDPOINT_LOCKED", "Firedrill clients connect only to production.", "Remove the API-address override. Keep development credentials and recovery files separate; do not replay them in production.", { workStarted: false, uncertain: false, retry: "never" });
}
export function resolveApiUrl(...values) {
    // Check every provided source, including an environment value shadowed by options.
    for (const value of [...values, process.env.FIREDRILL_API_URL])
        normalizeApiUrl(value);
    return FIREDRILL_API_ORIGIN;
}

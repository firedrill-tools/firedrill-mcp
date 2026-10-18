import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ArtifactSchema, RETENTION_VERSION } from "../contracts/index.js";
import { FiredrillError } from "./errors.js";
function identifier(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
        throw new FiredrillError("ARTIFACT_ID_INVALID", "Select an exact retained run and artifact ID.", "Use the IDs returned by artifacts(runId); a URL or local filename is not an artifact ID.");
    return value;
}
export function artifactPath(runId, artifactId) {
    return `/v1/runs/${identifier(runId)}/artifacts${artifactId === undefined ? "" : `/${identifier(artifactId)}`}`;
}
function retention(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return;
    const item = value;
    if (item.schemaVersion !== RETENTION_VERSION || ![RETENTION_VERSION, "historical_preserved"].includes(item.policyVersion) || !["available", "historical_preserved", "expired", "deletion_pending", "deleted"].includes(item.state))
        return;
    if ([item.payloadExpiresAt, item.metadataExpiresAt].some(date => date !== null && (typeof date !== "string" || date.length > 64 || !Number.isFinite(Date.parse(date)))))
        return;
    if (item.removalId !== null && (typeof item.removalId !== "string" || !/^removal_[a-f0-9]{24}$/.test(item.removalId)))
        return;
    return { schemaVersion: item.schemaVersion, policyVersion: item.policyVersion, state: item.state, payloadExpiresAt: item.payloadExpiresAt, metadataExpiresAt: item.metadataExpiresAt, removalId: item.removalId };
}
function reference(value, runId, artifactId) {
    const invalid = () => new FiredrillError("ARTIFACT_RESPONSE_MISMATCH", "The retained artifact metadata could not be confirmed.", "Read the same run and artifact again in its original scope. No target is rerun and no file is written.", { runId });
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalid();
    const row = value;
    if (row.runId !== runId || artifactId !== undefined && row.id !== artifactId || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(row.id))
        throw invalid();
    const availability = retention(row.retention);
    if (row.retention !== undefined && !availability)
        throw invalid();
    if (row.metadataOnly === true) {
        if (!availability || !["expired", "deletion_pending", "deleted"].includes(availability.state))
            throw invalid();
        return { id: row.id, runId, metadataOnly: true, retention: availability };
    }
    if (row.metadataOnly !== undefined && row.metadataOnly !== false || availability && !["available", "historical_preserved"].includes(availability.state))
        throw invalid();
    const parsed = ArtifactSchema.safeParse(Object.fromEntries(Object.keys(ArtifactSchema.shape).map(key => [key, row[key]])));
    if (!parsed.success || row.runId !== runId || artifactId !== undefined && row.id !== artifactId ||
        typeof row.attemptId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(row.attemptId) ||
        row.state !== "pending" && row.state !== "available")
        throw invalid();
    const path = `${artifactPath(runId, parsed.data.id)}/content`;
    if (row.downloadPath !== path || row.uploadPath !== path)
        throw invalid();
    return { ...parsed.data, runId, attemptId: row.attemptId, state: row.state, uploadPath: path, downloadPath: path, ...(availability ? { retention: availability } : {}) };
}
export async function readArtifacts(reader, runId) {
    const value = await reader.json(artifactPath(runId));
    if (!value || typeof value !== "object" || !Array.isArray(value.items) || value.items.length > 128)
        throw new FiredrillError("ARTIFACT_RESPONSE_MISMATCH", "The artifact manifest is not a bounded retained listing.", "Read this same run again. No capture is inferred from an incomplete manifest.", { runId });
    const items = value.items.map(item => reference(item, runId));
    if (new Set(items.map(item => item.id)).size !== items.length)
        throw new FiredrillError("ARTIFACT_RESPONSE_MISMATCH", "The artifact manifest repeats an identity.", "Read the same manifest again; no ambiguous file is selected.", { runId });
    return { items };
}
export async function readArtifactContent(reader, runId, artifactId) {
    const path = artifactPath(runId, artifactId);
    const artifact = reference(await reader.json(path), runId, artifactId);
    if (artifact.metadataOnly === true)
        throw new FiredrillError("ARTIFACT_UNAVAILABLE", `The capture is ${artifact.retention.state}; only its history remains.`, "Inspect retained metadata. Do not recreate removed evidence by rerunning the target.", { runId });
    if (artifact.state !== "available")
        throw new FiredrillError("ARTIFACT_PENDING", "This capture has not finished uploading.", "Inspect the original run or let its runner reconcile the pending upload. Do not repeat the target to create replacement evidence.", { runId });
    const reply = await reader.content(`${path}/content`, artifact.bytes);
    if (reply.content.byteLength !== artifact.bytes || createHash("sha256").update(reply.content).digest("hex") !== artifact.sha256 || reply.mediaType?.split(";", 1)[0]?.trim().toLowerCase() !== artifact.mediaType)
        throw new FiredrillError("ARTIFACT_CONTENT_MISMATCH", "Downloaded evidence does not match its retained size, digest or media type.", "Read the same retained artifact again. Unverified content is not returned or written; the target is not rerun.", { runId });
    return { artifact, content: reply.content };
}
/** Publish verified bytes to an explicit new path, never a server-selected filename. */
export function saveArtifactContent(value, output) {
    if (typeof output !== "string" || !output.trim() || output.includes("\0"))
        throw new FiredrillError("ARTIFACT_OUTPUT_INVALID", "Choose an explicit new local file for this capture.", "Use an existing output directory and a new filename. Existing files are never overwritten.");
    const path = resolve(output), temporary = join(dirname(path), `.firedrill-artifact-${randomUUID()}`);
    let fd, created = false;
    try {
        fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        created = true;
        writeFileSync(fd, value.content);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        linkSync(temporary, path); // Atomic publication; EEXIST cannot replace a file or symlink.
        return { artifact: value.artifact, path, verified: true };
    }
    catch {
        throw new FiredrillError("ARTIFACT_OUTPUT_UNAVAILABLE", "The verified capture could not be saved to that new path.", "Choose a new filename in an existing writable directory. Existing files are preserved; retrying this download does not execute the target.", { runId: value.artifact.runId });
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* Preserve the original save diagnostic. */ }
        }
        if (created) {
            try {
                unlinkSync(temporary);
            }
            catch { /* The private staging file may remain after a filesystem failure. */ }
        }
    }
}

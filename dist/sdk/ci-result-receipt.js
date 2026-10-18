import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FiredrillError } from "./errors.js";
export const CI_RESULT_RECEIPT_VERSION = "2026-10-18-ci-result.1";
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function failure() { throw new FiredrillError("CI_RESULT_RECEIPT_UNAVAILABLE", "The CI result reference could not be saved safely.", "Preserve the simulation journal and inspect its admitted batch. Use an existing private, caller-owned FIREDRILL_CI_RESULT_DIRECTORY; no replacement simulation is required."); }
/** Result references contain no output, credential or verdict. The final CI step
 * always reads authoritative service results; a script cannot make a gate pass
 * by editing a local status. Called after admission and before target claims. */
export function writeCiResultReceipt(batch) {
    const directory = process.env.FIREDRILL_CI_RESULT_DIRECTORY;
    if (directory === undefined)
        return;
    if (process.env.GITHUB_ACTIONS !== "true" || ![batch.id, batch.projectId, batch.environmentId].every(opaque) ||
        !isAbsolute(directory) || resolve(directory) !== directory || /[\x00-\x1f\x7f]/.test(directory) ||
        typeof process.getuid !== "function" || !constants.O_NOFOLLOW)
        failure();
    let fd;
    try {
        for (let part = directory;; part = dirname(part)) {
            if (lstatSync(part).isSymbolicLink())
                failure();
            if (dirname(part) === part)
                break;
        }
        if (realpathSync(directory) !== directory)
            failure();
        const before = lstatSync(directory), uid = process.getuid();
        if (!before.isDirectory() || before.uid !== uid || before.mode & 0o077)
            failure();
        const path = join(directory, `${batch.id}.json`), receipt = {
            schemaVersion: CI_RESULT_RECEIPT_VERSION, batchId: batch.id, projectId: batch.projectId, environmentId: batch.environmentId,
        }, content = Buffer.from(JSON.stringify(receipt) + "\n");
        if (existsSync(path)) {
            fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const file = fstatSync(fd);
            if (!file.isFile() || file.nlink !== 1 || file.uid !== uid || file.mode & 0o077 || file.size !== content.length)
                failure();
            const bytes = Buffer.alloc(content.length + 1), length = readSync(fd, bytes);
            if (length !== content.length || !bytes.subarray(0, length).equals(content))
                failure();
        }
        else {
            fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            if (writeSync(fd, content) !== content.length)
                failure();
            fsyncSync(fd);
        }
        const after = lstatSync(directory), named = lstatSync(path), file = fstatSync(fd);
        if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.uid !== uid || after.mode & 0o077 ||
            !file.isFile() || file.nlink !== 1 || file.uid !== uid || file.mode & 0o077 || named.isSymbolicLink() ||
            file.dev !== named.dev || file.ino !== named.ino || file.size !== content.length)
            failure();
    }
    catch (error) {
        if (error instanceof FiredrillError)
            throw error;
        failure();
    }
    finally {
        if (fd !== undefined)
            try {
                closeSync(fd);
            }
            catch { /* No credential or target data is stored here. */ }
    }
}

import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { FiredrillError } from "./errors.js";
const invalid = () => new FiredrillError("JOURNAL_UNSAFE", "Recovery storage is unsafe or invalid.", "Use a private owned directory; preserve existing recovery files for inspection.");
function directory(path) {
    if (!existsSync(path)) {
        directory(dirname(path));
        try {
            mkdirSync(path, { mode: 0o700 });
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
        }
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw invalid();
}
function readPrivate(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
            throw invalid();
        return readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
}
export class JournalStore {
    directory;
    constructor(path = join(homedir(), ".local", "state", "firedrill", "executions")) {
        this.directory = resolve(path);
        directory(this.directory);
        const stat = lstatSync(this.directory);
        if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
            throw invalid();
    }
    path(id, extension = "json") {
        if (!/^[a-f0-9-]{36}$/.test(id))
            throw invalid();
        return join(this.directory, `${id}.${extension}`);
    }
    read(id) {
        const value = JSON.parse(readPrivate(this.path(id)));
        if (value.version !== 1 || value.id !== id || !Array.isArray(value.work) || !["create", "active", "done"].includes(value.phase))
            throw invalid();
        return value;
    }
    save(value) {
        const path = this.path(value.id), temporary = `${path}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify(value));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, path);
        const parent = openSync(this.directory, "r");
        try {
            fsyncSync(parent);
        }
        finally {
            closeSync(parent);
        }
    }
    lock(id) {
        const path = this.path(id, "lock");
        const busy = () => new FiredrillError("JOURNAL_BUSY", "Another process owns or is recovering this operation.", "Wait for that process to exit. If recovery itself crashed, inspect its exact reclaim file before removal.");
        const acquire = () => {
            const fd = openSync(path, "wx", 0o600);
            try {
                writeFileSync(fd, String(process.pid));
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
        };
        try {
            acquire();
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            // Serialize stale-lock recovery. Without this guard, two observers of an old
            // PID could unlink each other's newly acquired lock and both invoke a target.
            const guard = this.path(id, "reclaim");
            let fd;
            try {
                fd = openSync(guard, "wx", 0o600);
            }
            catch (e) {
                if (e.code === "EEXIST")
                    throw busy();
                throw e;
            }
            try {
                writeFileSync(fd, String(process.pid));
                fsyncSync(fd);
                if (existsSync(path)) {
                    const pid = Number(readPrivate(path));
                    if (!Number.isSafeInteger(pid) || pid <= 0)
                        throw invalid();
                    try {
                        process.kill(pid, 0);
                        throw busy();
                    }
                    catch (e) {
                        if (e.code !== "ESRCH")
                            throw e;
                    }
                    unlinkSync(path);
                }
                try {
                    acquire();
                }
                catch (e) {
                    if (e.code === "EEXIST")
                        throw busy();
                    throw e;
                }
            }
            finally {
                closeSync(fd);
                unlinkSync(guard);
            }
        }
        return () => { if (existsSync(path) && readPrivate(path) === String(process.pid))
            unlinkSync(path); };
    }
}

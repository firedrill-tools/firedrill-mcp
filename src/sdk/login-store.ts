import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FiredrillError } from "./errors.js";

const LIMIT = 64 * 1024;
const failure = () => new FiredrillError("FD_LOGIN_STORE_UNSAFE", "The protected login store could not be safely accessed.", "Use an owner-only directory outside repositories, with regular owner-only files. Do not delete pending login state to recover a network failure.");
const lockRepair = (path: string) => new FiredrillError("FD_LOGIN_LOCK_RECOVERY_REQUIRED", "An interrupted login lock cannot be recovered automatically.", `Stop all Firedrill processes using this login store, then inspect and remove only this exact lock file: ${path}. Preserve session.json and its pending refresh/exchange state; do not remove the directory.`);
function privateDirectory(path: string) {
  if (typeof process.getuid !== "function") throw failure();
  const uid = process.getuid();
  let current = parse(path).root;
  const segments = path.slice(current.length).split("/").filter(Boolean);
  for (const part of segments) {
    current = join(current, part);
    if (existsSync(join(current, ".git"))) throw failure();
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failure(); }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid && stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)) throw failure();
  }
  const stat = lstatSync(path);
  if (stat.uid !== uid || (stat.mode & 0o077) !== 0) throw failure();
}
function readProtected(path: string): unknown | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw failure(); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > LIMIT) throw failure();
    const bytes = Buffer.alloc(LIMIT + 1); let count = 0;
    while (count <= LIMIT) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    if (count > LIMIT) throw failure();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } catch { throw failure(); } finally { closeSync(fd); }
}
function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeProtected(path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > LIMIT) throw failure();
  // Validate an existing destination before replacing it; never follow a link.
  readProtected(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try { fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); syncDirectory(dirname(path)); }
  catch { throw failure(); }
  finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* Only this write's exact temporary file. */ } }
}

/** Private local authentication storage, never an execution journal or repo file. */
export class LoginStore {
  readonly #directory: string;
  readonly #statePath: string;
  readonly #lockPath: string;
  constructor(apiUrl: string, directory = join(homedir(), ".local", "state", "firedrill", "login")) {
    const base = resolve(directory); privateDirectory(base);
    this.#directory = join(base, createHash("sha256").update(apiUrl).digest("hex")); privateDirectory(this.#directory);
    this.#statePath = join(this.#directory, "session.json"); this.#lockPath = join(this.#directory, "session.lock");
  }
  read(): unknown | undefined { privateDirectory(this.#directory); return readProtected(this.#statePath); }
  write(value: unknown) { privateDirectory(this.#directory); writeProtected(this.#statePath, value); }
  clear() { privateDirectory(this.#directory); if (readProtected(this.#statePath) !== undefined) { unlinkSync(this.#statePath); syncDirectory(this.#directory); } }
  async locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const nonce = randomUUID(), began = performance.now();
    const owner = { pid: process.pid, nonce };
    for (;;) {
      if (signal?.aborted) throw new FiredrillError("FD_LOGIN_CANCELLED", "Sign-in was cancelled.", "Pending protected state was preserved.");
      privateDirectory(this.#directory);
      let fd: number | undefined;
      try { fd = openSync(this.#lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); closeSync(fd); fd = undefined; break; }
      catch (error) {
        if (fd !== undefined) { closeSync(fd); throw failure(); }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failure();
        let prior: { pid?: unknown; nonce?: unknown } | undefined;
        try { prior = readProtected(this.#lockPath) as typeof prior; }
        catch { if (performance.now() - began < 500) { await delay(50); continue; } throw lockRepair(this.#lockPath); }
        if (!prior || !Number.isSafeInteger(prior.pid) || Number(prior.pid) < 1 || typeof prior.nonce !== "string") {
          if (performance.now() - began < 500) { await delay(50); continue; }
          throw lockRepair(this.#lockPath);
        }
        let dead = false;
        try { process.kill(Number(prior.pid), 0); } catch (cause) { dead = (cause as NodeJS.ErrnoException).code === "ESRCH"; }
        if (dead) {
          const guard = `${this.#lockPath}.reclaim`; let guardFd: number | undefined;
          try {
            guardFd = openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            writeFileSync(guardFd, JSON.stringify(owner)); fsyncSync(guardFd);
            const still = readProtected(this.#lockPath) as typeof prior;
            if (still?.nonce === prior.nonce && still.pid === prior.pid) unlinkSync(this.#lockPath);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw failure();
            let reclaim: { pid?: number } | undefined;
            try { reclaim = readProtected(guard) as typeof reclaim; } catch { throw lockRepair(guard); }
            if (!reclaim || !Number.isSafeInteger(reclaim.pid) || reclaim.pid! < 1) throw lockRepair(guard);
            try { process.kill(reclaim.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") throw lockRepair(guard); }
          }
          finally { if (guardFd !== undefined) { closeSync(guardFd); unlinkSync(guard); } }
        }
        if (performance.now() - began > 30_000) throw new FiredrillError("FD_LOGIN_BUSY", "Another process is using this protected login.", "Wait for the active login or refresh. A live lock is never stolen.");
        await delay(100);
      }
    }
    try { return await work(); }
    finally {
      const current = readProtected(this.#lockPath) as { nonce?: string } | undefined;
      if (current?.nonce === nonce) { unlinkSync(this.#lockPath); syncDirectory(this.#directory); }
    }
  }
  toJSON() { return { kind: "LoginStore", protected: true }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return this.toJSON(); }
}

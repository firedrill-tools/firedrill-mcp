import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { FiredrillError } from "./errors.js";

/** Read an explicitly selected data file, never an import or executable config. */
export function readJsonInput(path: string, maximum: number, code: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Not a bounded regular file");
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length <= maximum) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximum) throw new Error("Input grew beyond bound");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    throw new FiredrillError(code, "The selected input must be an accessible, bounded regular UTF-8 JSON file.", `Correct the selected file (maximum ${maximum} bytes). File symlinks, device files and malformed JSON are not accepted; no simulation was started.`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readPublicConfig(path: string): Record<"apiUrl" | "projectId" | "environmentId", string | undefined> {
  const value = readJsonInput(path, 65536, "CONFIG_INVALID");
  if (!value || Array.isArray(value) || typeof value !== "object" ||
    Object.keys(value).some(key => !["apiUrl", "projectId", "environmentId"].includes(key)) ||
    Object.values(value).some(item => typeof item !== "string" || !item.trim() || item.length > 2048 || /[\r\n\0]/.test(item)))
    throw new FiredrillError("CONFIG_INVALID", "Config supports only nonempty public apiUrl, projectId and environmentId strings.", "Remove credentials and unsupported fields. Credentials come from explicit client options or FIREDRILL_TOKEN.");
  const config = value as Record<"apiUrl" | "projectId" | "environmentId", string | undefined>;
  if (Boolean(config.projectId) !== Boolean(config.environmentId))
    throw new FiredrillError("CONFIG_INVALID", "Project and environment must be selected together.", "Run firedrill init or supply both IDs in the selected config.");
  return config;
}

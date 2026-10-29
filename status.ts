// Failure-autopilot status index (feature B, V005). Bounded tail reads of
// session jsonl files + a JSON sidecar cache keyed by path + mtime + size.
// Sidecar writes go through a temp file + rename (same pattern as pins.ts).
// No pi imports.
import { openSync, readSync, statSync, closeSync } from "node:fs";
import { readJsonSafe, writeJsonSafe } from "./cache.ts";

export const STATUS_FILE = ".session-manager-status.json";

/** Conservative run classification: nothing guessed, malformed → unknown. */
export type RunStatus = "ok" | "error" | "killed" | "unknown";

/** At most this many bytes are read from the end of any session file. */
export const TAIL_CAP_BYTES = 64 * 1024;

/** Max error text kept per file (details-pane friendly). */
const ERROR_TEXT_CAP = 200;

export type TailStatus = { status: RunStatus; error?: string };

/**
 * Bounded tail read: seek from EOF and read at most `cap` bytes, so the
 * classifier never pays the O(file) whole-read cost on large jsonl files.
 * A file with no trailing newline comes back with that partial last line
 * intact — the crash-killed signature (V005).
 */
export function readTail(file: string, cap: number = TAIL_CAP_BYTES): string {
  const fd = openSync(file, "r");
  try {
    const { size } = statSync(file);
    const readBytes = Math.min(size, cap);
    const buffer = Buffer.alloc(readBytes);
    readSync(fd, buffer, 0, readBytes, size - readBytes);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Best-effort error text extraction from a record that signaled failure. */
function errorText(record: Record<string, unknown>): string | undefined {
  const from = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const message = (value as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    return undefined;
  };
  const error = from(record.error) ?? from((record.message as Record<string, unknown> | undefined)?.error);
  if (error !== undefined) return error.slice(0, ERROR_TEXT_CAP);
  try {
    return JSON.stringify(record).slice(0, ERROR_TEXT_CAP);
  } catch {
    return undefined;
  }
}

/**
 * Classify a raw file tail. Conservative rules:
 * - empty tail → unknown
 * - a trailing partial line (no newline at EOF) → killed: the writer died
 *   mid-record, so the last complete record never arrived
 * - last complete line unparseable → unknown (malformed, never guessed)
 * - last record carries an error signal (type "error", `error`, or
 *   `message.error`) → error, with the extracted text
 * - otherwise → ok
 */
export function classifyTail(tail: string): TailStatus {
  if (tail.trim() === "") return { status: "unknown" };
  const endsWithNewline = tail.endsWith("\n") || tail.endsWith("\r");
  const lines = tail.split(/\r?\n/);
  // drop the trailing "" after a final newline; the last element otherwise
  // is a partial (newline-less) line
  if (endsWithNewline) lines.pop();
  const partial = endsWithNewline ? null : (lines.pop() ?? null);
  let lastComplete: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      lastComplete = lines[i];
      break;
    }
  }
  if (lastComplete === undefined) return { status: "unknown" };
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(lastComplete);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "unknown" };
    record = parsed as Record<string, unknown>;
  } catch {
    return { status: "unknown" };
  }
  const isError =
    record.type === "error" ||
    record.isError === true ||
    record.error !== undefined ||
    (record.message && typeof record.message === "object" &&
      (record.message as Record<string, unknown>).error !== undefined);
  if (partial !== null && partial.trim() !== "") {
    // a partial line beats the error signal: the run died before finishing
    // the record that might have reported the error
    return { status: "killed", ...(isError ? { error: errorText(record) } : {}) };
  }
  if (isError) return { status: "error", error: errorText(record) };
  return { status: "ok" };
}

/** Classify one session file with a bounded tail read. */
export function classifyFile(file: string): TailStatus {
  try {
    return classifyTail(readTail(file));
  } catch {
    return { status: "unknown" };
  }
}

/** One sidecar entry: identity (mtime+size) plus the cached result. */
export type StatusEntry = { mtimeMs: number; size: number; status: RunStatus; error?: string };
export type StatusIndex = Record<string, StatusEntry>;

/** A cached entry is valid only when path, mtime, AND size all match. */
export function lookupStatus(index: StatusIndex, path: string, mtimeMs: number, size: number): StatusEntry | undefined {
  const entry = index[path];
  if (!entry) return undefined;
  return entry.mtimeMs === mtimeMs && entry.size === size ? entry : undefined;
}

/** A missing or malformed sidecar is an empty index. */
export async function loadStatusIndex(file: string): Promise<StatusIndex> {
  const value = await readJsonSafe(file);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const index: StatusIndex = {};
    for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as Record<string, unknown> | null;
      if (
        e && typeof e === "object" &&
        typeof e.mtimeMs === "number" && typeof e.size === "number" &&
        (e.status === "ok" || e.status === "error" || e.status === "killed" || e.status === "unknown")
      ) {
        index[path] = {
          mtimeMs: e.mtimeMs,
          size: e.size,
          status: e.status,
          ...(typeof e.error === "string" ? { error: e.error } : {}),
        };
      }
    }
    return index;
  }
  return {};
}

/** Write via cache.writeJsonSafe (serialized temp + atomic rename). */
export async function saveStatusIndex(file: string, index: StatusIndex): Promise<void> {
  await writeJsonSafe(file, index);
}

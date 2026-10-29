// Read-only metadata extraction from session JSONL files. No pi imports.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { MetaCache, MetaCacheEntry } from "./meta-cache.ts";

export type SessionMeta = { name?: string; lastModel?: string; contextPercent?: number };

type JsonRecord = Record<string, unknown>;

/** At most this many bytes are read to locate the session header line. */
const HEADER_CAP_BYTES = 8192;

/** Read every non-empty line as a JSON object. Malformed lines are dropped. */
function readRecords(file: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") records.push(value as JsonRecord);
    } catch {
      // ignore malformed line
    }
  }
  return records;
}

/**
 * Parse the first JSONL line. It holds the session header (type "session").
 * Only the first HEADER_CAP_BYTES bytes are read, so a huge session body is
 * never loaded just to recover the header.
 */
export function readSessionHeader(file: string): { id: string; cwd: string; parentSession?: string } {
  const fd = openSync(file, "r");
  let buffer: Buffer;
  try {
    const { size } = statSync(file);
    const readBytes = Math.min(size, HEADER_CAP_BYTES);
    buffer = Buffer.alloc(readBytes);
    if (readBytes > 0) readSync(fd, buffer, 0, readBytes, 0);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const end = text.indexOf("\n");
  const first = (end === -1 ? text : text.slice(0, end)).trim();
  const header = JSON.parse(first) as JsonRecord;
  if (header.type !== "session") {
    throw new Error(`no session header in ${file}`);
  }
  const result: { id: string; cwd: string; parentSession?: string } = {
    id: String(header.id ?? ""),
    cwd: String(header.cwd ?? ""),
  };
  if (typeof header.parentSession === "string") result.parentSession = header.parentSession;
  return result;
}

/** Sum the text length of one message content value. */
export function countMessageChars(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const content = (message as JsonRecord).content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as JsonRecord;
      if (typeof record.text === "string") total += record.text.length;
      if (typeof record.thinking === "string") total += record.thinking.length;
    }
    return total;
  }
  return 0;
}

/**
 * Read name, last model, and context usage from a session file.
 * name and lastModel come from the last matching record.
 * contextPercent is undefined when contextWindow is not a positive number.
 */
export function readSessionMeta(file: string, contextWindow?: number): SessionMeta {
  let name: string | undefined;
  let lastModel: string | undefined;
  let totalChars = 0;

  for (const record of readRecords(file)) {
    if (record.type === "session_info") {
      name = typeof record.name === "string" ? record.name : undefined;
    } else if (record.type === "model_change") {
      const provider = record.provider;
      const modelId = record.modelId;
      lastModel =
        typeof provider === "string" && typeof modelId === "string"
          ? `${provider}/${modelId}`
          : undefined;
    } else if (record.type === "message") {
      totalChars += countMessageChars(record.message);
    }
  }

  const meta: SessionMeta = { name, lastModel };
  if (typeof contextWindow === "number" && contextWindow > 0) {
    meta.contextPercent = Math.round((totalChars / 4 / contextWindow) * 100);
  }
  return meta;
}

/** Running aggregation over a run of parsed JSONL records. */
type MetaAccum = { name?: string; lastModel?: string; totalChars: number };

/** Fold one record into the running aggregation (same rules as readSessionMeta). */
function applyRecord(state: MetaAccum, record: JsonRecord): void {
  if (record.type === "session_info") {
    state.name = typeof record.name === "string" ? record.name : undefined;
  } else if (record.type === "model_change") {
    const provider = record.provider;
    const modelId = record.modelId;
    state.lastModel =
      typeof provider === "string" && typeof modelId === "string"
        ? `${provider}/${modelId}`
        : undefined;
  } else if (record.type === "message") {
    state.totalChars += countMessageChars(record.message);
  }
}

/** Parse JSONL text into objects, dropping blank and malformed lines. */
function parseRecords(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") records.push(value as JsonRecord);
    } catch {
      // ignore malformed line
    }
  }
  return records;
}

/** Read the byte range [start, end) into a Buffer. Byte-based for utf8 safety. */
export function readRange(file: string, start: number, end: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, start);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/**
 * Incremental metadata read backed by a MetaCache. On an unchanged file the
 * cached counters are reused; on an appended file only the new byte range is
 * parsed; anything else triggers a full recompute. Byte offsets are tracked so
 * multi-byte utf8 text is never split across a cached boundary.
 */
export function readSessionMetaCached(
  file: string,
  contextWindow: number | undefined,
  cache: MetaCache,
): SessionMeta {
  const st = statSync(file);
  const prev = cache[file];
  let entry: MetaCacheEntry;

  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    // HIT: nothing changed, reuse the aggregated counters.
    entry = prev;
  } else if (prev && st.size > prev.size) {
    // GROW: parse only the new byte range.
    const buffer = readRange(file, prev.cachedBytes, st.size);
    const idx = buffer.lastIndexOf(0x0a);
    if (idx === -1) {
      // No complete line yet: keep counters, advance only the identity.
      entry = {
        ...prev,
        mtimeMs: st.mtimeMs,
        size: st.size,
      };
    } else {
      const state: MetaAccum = {
        name: prev.name,
        lastModel: prev.lastModel,
        totalChars: prev.totalChars,
      };
      for (const record of parseRecords(buffer.subarray(0, idx + 1).toString("utf8"))) {
        applyRecord(state, record);
      }
      entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        cachedBytes: prev.cachedBytes + idx + 1,
        totalChars: state.totalChars,
        ...(state.name !== undefined ? { name: state.name } : {}),
        ...(state.lastModel !== undefined ? { lastModel: state.lastModel } : {}),
      };
    }
  } else {
    // MISS/FULL: no usable entry, shrinking file, or same size with new mtime.
    const buffer = readFileSync(file);
    const idx = buffer.lastIndexOf(0x0a);
    const state: MetaAccum = { totalChars: 0 };
    if (idx !== -1) {
      for (const record of parseRecords(buffer.subarray(0, idx + 1).toString("utf8"))) {
        applyRecord(state, record);
      }
    }
    entry = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      cachedBytes: idx === -1 ? 0 : idx + 1,
      totalChars: state.totalChars,
      ...(state.name !== undefined ? { name: state.name } : {}),
      ...(state.lastModel !== undefined ? { lastModel: state.lastModel } : {}),
    };
  }

  cache[file] = entry;
  const meta: SessionMeta = { name: entry.name, lastModel: entry.lastModel };
  if (typeof contextWindow === "number" && contextWindow > 0) {
    meta.contextPercent = Math.round((entry.totalChars / 4 / contextWindow) * 100);
  }
  return meta;
}

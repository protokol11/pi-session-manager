// Incremental metadata cache shared by the explorer/list read paths. Each entry
// keys a session file by mtime + size and remembers how many bytes were already
// aggregated, so a growing JSONL file only re-reads its new tail. Persisted via
// cache.ts (serialized temp + atomic rename). No pi imports.
import { readJsonSafe, writeJsonSafe } from "./cache.ts";

/** Sidecar file name for the metadata cache. */
export const META_FILE = ".session-manager-meta.json";

/** One cached entry: file identity plus the aggregated counters. */
export type MetaCacheEntry = {
  mtimeMs: number;
  size: number;
  cachedBytes: number;
  totalChars: number;
  name?: string;
  lastModel?: string;
};

export type MetaCache = Record<string, MetaCacheEntry>;

/** A missing, malformed, or wrongly-shaped sidecar is an empty cache. */
export async function loadMetaCache(file: string): Promise<MetaCache> {
  const value = await readJsonSafe(file);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const cache: MetaCache = {};
    for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
      const e = entry as Record<string, unknown> | null;
      if (
        e && typeof e === "object" &&
        typeof e.mtimeMs === "number" &&
        typeof e.size === "number" &&
        typeof e.cachedBytes === "number" &&
        typeof e.totalChars === "number"
      ) {
        cache[path] = {
          mtimeMs: e.mtimeMs,
          size: e.size,
          cachedBytes: e.cachedBytes,
          totalChars: e.totalChars,
          ...(typeof e.name === "string" ? { name: e.name } : {}),
          ...(typeof e.lastModel === "string" ? { lastModel: e.lastModel } : {}),
        };
      }
    }
    return cache;
  }
  return {};
}

/** Write via cache.writeJsonSafe (serialized temp + atomic rename). */
export async function saveMetaCache(file: string, cache: MetaCache): Promise<void> {
  await writeJsonSafe(file, cache);
}

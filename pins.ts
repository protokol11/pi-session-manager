// Pinned sessions for the Quick access view. Plain JSON next to the store
// (dotfile — the walker only picks up *.jsonl files, so it stays invisible
// to the explorer). No pi imports.
import { readFile, rename, writeFile } from "node:fs/promises";

export const PINS_FILE = ".session-manager-pins.json";

/** Pure toggle: pin if absent (appended), unpin if present. */
export function togglePin(paths: string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path];
}

/** A missing or malformed pins file is an empty pin list. */
export async function loadPins(file: string): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(value?.paths)) return value.paths.filter((p: unknown) => typeof p === "string");
  } catch {
    // missing or malformed — treat as empty
  }
  return [];
}

/** Write via a temp file + rename so a crash cannot leave a half-written list. */
export async function savePins(file: string, paths: string[]): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ paths }, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

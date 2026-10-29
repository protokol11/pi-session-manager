// Tag-alias table for sprint B (cwd-vs-tag membership). Dotfile next to the
// store — the walker only picks up *.jsonl files, so it stays invisible to
// the explorer. No pi imports.
// Format: { "aliases": { "<short-form>": "<project key>" } } where the value
// is the trailing kebab-slug of a project dir (e.g. "minecraft-typescript").
import { readFile, rename, writeFile } from "node:fs/promises";
import type { AliasTable } from "./tags.ts";

export const ALIASES_FILE = ".session-manager-aliases.json";

/** A missing or malformed aliases file is an empty table. */
export async function loadAliases(file: string): Promise<AliasTable> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    const aliases = value?.aliases;
    if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
      const out: AliasTable = {};
      for (const [key, v] of Object.entries(aliases)) {
        if (typeof key === "string" && typeof v === "string") out[key] = v;
      }
      return out;
    }
  } catch {
    // missing or malformed — treat as empty
  }
  return {};
}

/** Write via a temp file + rename so a crash cannot leave a half-written table. */
export async function saveAliases(file: string, aliases: AliasTable): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ aliases }, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

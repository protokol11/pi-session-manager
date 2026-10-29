// Handoff linkage: scan `<cwd>/.docs/handoff/*.md` for session frontmatter.
// Pure node:fs/promises. No YAML dependency; a minimal `key: value` frontmatter
// parser covers the `sessionId` field this extension needs.
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const HANDOFF_SUBDIR = [".docs", "handoff"];

/** Strip matching single or double quotes and surrounding whitespace. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed.charAt(0);
  if ((first === '"' || first === "'") && trimmed.length >= 2 && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Read `sessionId` from a leading `---` frontmatter block, or undefined. */
function readSessionId(text: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const match = /^sessionId\s*:\s*(.*)$/.exec(line);
    if (match) {
      const value = unquote(match[1]);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Map `sessionId → handoff path` for every handoff document under cwd.
 * Files without frontmatter or without a `sessionId` are skipped. A missing
 * handoff directory yields an empty map.
 */
export async function scanHandoffs(cwd: string): Promise<Map<string, string>> {
  const dir = join(cwd, ...HANDOFF_SUBDIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return new Map();
  }

  const map = new Map<string, string>();
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    const sessionId = readSessionId(await readFile(full, "utf8"));
    if (sessionId === undefined) continue;
    map.set(sessionId, relative(cwd, full));
  }
  return map;
}

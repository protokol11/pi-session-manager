// Read-only walker over the pi session store. No mutations, no pi imports.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { readSessionHeader, readSessionMeta, readSessionMetaCached } from "./metadata.ts";
import type { MetaCache } from "./meta-cache.ts";

export type SessionNode = {
  path: string;
  id: string;
  name?: string;
  children: SessionNode[];
  cwd?: string;
  model?: string;
  contextPercent?: number;
  mtimeMs?: number;
  parentSessionPath?: string;
};

/**
 * Optional read context threaded through the walk. When present, node
 * metadata comes from the incremental `MetaCache` (one read per file per
 * open); when absent the walk keeps its uncached, name-only behavior.
 */
export type WalkContext = { cache: MetaCache; contextWindow: number };

export type FolderNode = { path: string; name: string; sessions: SessionNode[]; folders: FolderNode[] };
export type TrashNode = { path: string };
export type ProjectNode = {
  path: string;
  /** Raw store dir name — the identity used for all matching and file ops. */
  name: string;
  /** Human display name: cwd basename from a session header (`~` for home). */
  displayName: string;
  /** The project cwd: decoded store dir name, else majority-vote fallback
   *  (display source and the "which project am I in" match on entry). */
  cwd?: string;
  sessions: SessionNode[];
  folders: FolderNode[];
  trash?: TrashNode;
};

/** Directories that never hold sessions. */
const SKIP_DIRS = new Set(["subagent-artifacts"]);

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isJsonl(name: string): boolean {
  return extname(name) === ".jsonl" && !name.startsWith(".");
}

/** Build one session node. A malformed header falls back to `fallback` ?? the file stem. */
function readSessionNode(file: string, fallback?: string, ctx?: WalkContext): SessionNode {
  let id: string;
  let cwd: string | undefined;
  let parentSession: string | undefined;
  try {
    const header = readSessionHeader(file);
    id = header.id;
    if (header.cwd) cwd = header.cwd;
    if (header.parentSession !== undefined) parentSession = header.parentSession;
  } catch {
    id = fallback ?? basename(file, extname(file));
  }
  // meta + stat are best-effort: a malformed file still yields a node
  let name: string | undefined;
  let model: string | undefined;
  let contextPercent: number | undefined;
  try {
    const meta = ctx
      ? readSessionMetaCached(file, ctx.contextWindow, ctx.cache)
      : readSessionMeta(file);
    name = meta.name;
    model = meta.lastModel;
    contextPercent = meta.contextPercent;
  } catch {
    // keep undefined metadata
  }
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    // keep undefined mtime
  }
  const node: SessionNode = { path: file, id, children: [] };
  if (name !== undefined) node.name = name;
  if (cwd !== undefined) node.cwd = cwd;
  if (parentSession !== undefined) node.parentSessionPath = parentSession;
  if (model !== undefined) node.model = model;
  if (contextPercent !== undefined) node.contextPercent = contextPercent;
  if (mtimeMs !== undefined) node.mtimeMs = mtimeMs;
  return node;
}

/**
 * Collect sessions inside a companion dir, recursing into nested run dirs.
 * pi subagent layout is <stem>/<runId>/run-0/session.jsonl, so jsonl files
 * at any depth below the companion become child sessions. Depth-guarded.
 */
function collectSessions(dir: string, ctx?: WalkContext): SessionNode[] {
  const sessions: SessionNode[] = [];
  collectSessionDeep(dir, sessions, 0, ctx);
  return sessions;
}

/** Shared depth guard: companion-dir recursion and lens/ancestry derivation
 *  both cap nesting at this many levels (V006 — one constant, no divergent
 *  guards). */
export const MAX_COMPANION_DEPTH = 8;

function collectSessionDeep(dir: string, out: SessionNode[], depth: number, ctx?: WalkContext): void {
  if (depth > MAX_COMPANION_DEPTH) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isFile() && isJsonl(entry.name)) {
      // run-0/session.jsonl stems are all "session"; fall back to the run id
      // (grandparent dir) when the header is unreadable
      const fallback = entry.name === "session.jsonl" ? basename(dirname(dir)) : undefined;
      out.push(readSessionNode(p, fallback, ctx));
    } else if (entry.isDirectory()) {
      collectSessionDeep(p, out, depth + 1, ctx);
    }
  }
}

/**
 * Nesting steps from `candidatePath` up to `parentPath`, derived purely from
 * path nesting: the candidate's ancestor directories are walked upward and
 * compared against the parent's stem (a `.jsonl` parent's companion dir is
 * its stem). Returns -1 when the candidate is not a descendant, equals the
 * parent, or the guard depth is exceeded. Nothing is invented beyond the
 * filesystem layout — no header fields, no ids (FOG-OF-WAR).
 */
export function descendantDepth(parentPath: string, candidatePath: string): number {
  const parent = resolve(parentPath);
  const candidate = resolve(candidatePath);
  if (!parent || !candidate || candidate === parent) return -1;
  const stem = parent.endsWith(".jsonl") ? parent.slice(0, -".jsonl".length) : parent;
  let dir = dirname(candidate);
  for (let steps = 1; steps <= MAX_COMPANION_DEPTH; steps++) {
    if (dir === stem) return steps;
    const up = dirname(dir);
    if (up === dir) return -1;
    dir = up;
  }
  return -1;
}

export type AncestryStep = { kind: "stem"; path: string } | { kind: "gap" };

/**
 * Stem chain upward from a session file: each enclosing directory implies a
 * parent candidate `<dir>.jsonl` next to it. An existing stem is a stem
 * step; a missing stem is a `··· gap` marker, never a crash and never an
 * invented parent. Malformed input (empty/non-absolute-ish path that cannot
 * nest) yields an empty chain. The walk stops at the store root: project
 * level is not part of session ancestry.
 */
export function deriveAncestry(sessionPath: string, storeRoot: string): AncestryStep[] {
  if (!sessionPath || !storeRoot) return [];
  const root = resolve(storeRoot);
  let dir = dirname(resolve(sessionPath));
  if (!dir.startsWith(root) || dir === root) return [];
  const steps: AncestryStep[] = [];
  while (dir !== root && dirname(dir) !== root && dir.startsWith(root)) {
    const stem = join(dirname(dir), basename(dir) + ".jsonl");
    steps.push(existsSync(stem) ? { kind: "stem", path: stem } : { kind: "gap" });
    dir = dirname(dir);
  }
  return steps;
}

/** Walk one directory: top-level sessions + user folders (recursive). */
function walkDir(dir: string, ctx?: WalkContext): { sessions: SessionNode[]; folders: FolderNode[] } {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && isJsonl(e.name));
  const dirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name),
  );
  const stems = new Set(files.map((e) => basename(e.name, ".jsonl")));

  const sessions: SessionNode[] = [];
  for (const file of files) {
    const filePath = join(dir, file.name);
    const node = readSessionNode(filePath, undefined, ctx);
    const stem = basename(file.name, ".jsonl");
    const companionPath = join(dir, stem);
    if (isDir(companionPath)) node.children = collectSessions(companionPath, ctx);
    sessions.push(node);
  }

  const folders: FolderNode[] = [];
  for (const entry of dirs) {
    if (stems.has(entry.name)) continue; // companion dir, already handled above
    const folderPath = join(dir, entry.name);
    const sub = walkDir(folderPath, ctx);
    folders.push({ path: folderPath, name: entry.name, sessions: sub.sessions, folders: sub.folders });
  }

  return { sessions, folders };
}

/**
 * Decode a store dir name back to the cwd it encodes. pi encodes every path
 * separator AND the drive colon as "-", so the mapping is ambiguous on
 * paper — resolved by a greedy longest-match word-break against the real
 * filesystem: only the correct segmentation yields an existing path.
 * Returns undefined when no full segmentation exists (deleted/moved cwd).
 */
export function decodeStoreDir(name: string): string | undefined {
  const inner = name.replace(/^--/, "").replace(/--$/, "");
  const tokens = inner.split("-");
  if (tokens.length < 2 || !/^[A-Za-z]$/.test(tokens[0])) return undefined;
  const drive = tokens[0];
  // the drive colon and the first separator both encode as "-", leaving an
  // empty token ("C--Users"); empty components do not exist on Windows
  const rest = tokens.slice(1).filter((t) => t !== "");
  const sep = "\\";
  const components: string[] = [];
  let i = 0;
  while (i < rest.length) {
    let found = -1;
    for (let j = rest.length; j > i; j--) {
      const candidate = drive + ":" + sep + [...components, rest.slice(i, j).join("-")].join(sep);
      if (existsSync(candidate)) {
        found = j;
        break;
      }
    }
    if (found === -1) return undefined;
    components.push(rest.slice(i, found).join("-"));
    i = found;
  }
  return drive + ":" + sep + components.join(sep);
}

/**
 * A project's cwd: the decoded store dir name first — it encodes the path
 * the project was created from and is immune to paste-moved sessions
 * carrying a foreign cwd (the majority-vote regression: pasting one session
 * into an empty project renamed the project after the session's old home).
 * Majority vote across sessions is the fallback for undecodable dirs.
 */
function projectCwd(name: string, sessions: SessionNode[], folders: FolderNode[]): string | undefined {
  const decoded = decodeStoreDir(name);
  if (decoded !== undefined) return decoded;
  const counts = new Map<string, number>();
  const tally = (ss: SessionNode[], fs: FolderNode[]): void => {
    for (const s of ss) {
      // prefer the cwd already read during the walk; only re-read the header
      // when the node carries none (ctx absent or header unreadable)
      let cwd = s.cwd;
      if (cwd === undefined) {
        try {
          cwd = readSessionHeader(s.path).cwd;
        } catch {
          cwd = undefined;
        }
      }
      if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }
    for (const f of fs) tally(f.sessions, f.folders);
  };
  tally(sessions, folders);
  let best: string | undefined;
  for (const [cwd, n] of [...counts.entries()].sort()) {
    if (best === undefined || n > (counts.get(best) ?? 0)) best = cwd;
  }
  return best;
}

/**
 * Human display name for a project. The raw store dir name (`--C--…--`) is
 * machine identity, not a label. Falls back to a humanized dir name for
 * empty/unreadable projects.
 */
function projectDisplayName(name: string, cwd: string | undefined): string {
  if (cwd === undefined) return humanizeDirName(name);
  return cwd === homedir() ? "~" : basename(cwd);
}

/**
 * Fallback label from the raw store dir name for projects with no readable
 * sessions: strip the `--` wrappers and the drive, then take the trailing
 * lowercase kebab chain (`…-Desktop-model-eval` → `model-eval`). If the
 * chain is empty (PascalCase names), take the final token.
 */
function humanizeDirName(name: string): string {
  const inner = name.replace(/^--/, "").replace(/--$/, "").replace(/^[A-Za-z]-/, "");
  const tokens = inner.split("-");
  const chain: string[] = [];
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (/^[a-z0-9._ ]+$/.test(tokens[i])) chain.unshift(tokens[i]);
    else break;
  }
  if (chain.length > 0) return chain.join("-");
  return tokens[tokens.length - 1] || name;
}

function walkProject(path: string, name: string, ctx?: WalkContext): ProjectNode {
  const { sessions, folders } = walkDir(path, ctx);
  const cwd = projectCwd(name, sessions, folders);
  const project: ProjectNode = {
    path,
    name,
    displayName: projectDisplayName(name, cwd),
    sessions,
    folders,
  };
  if (cwd !== undefined) project.cwd = cwd;
  const trashPath = join(path, ".trash");
  if (isDir(trashPath)) project.trash = { path: trashPath };
  return project;
}

/** Walk the store root (~/.pi/agent/sessions/) into project nodes. */
export function walkStore(root: string, ctx?: WalkContext): ProjectNode[] {
  const projects: ProjectNode[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    projects.push(walkProject(join(root, entry.name), entry.name, ctx));
  }
  return projects;
}

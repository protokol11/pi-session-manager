// File operations over the pi session store: folders, session pairs, trash.
// Pure node:fs/promises primitives. No TUI, no pi imports.
// Errors propagate to the caller; nothing is swallowed except rollback cleanup.
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

/** One recoverable delete. `originalRelativePath` is relative to the store root. */
export type TrashEntry = {
  id: string;
  originalRelativePath: string;
  deletedAt: string;
};

const TRASH_DIR = ".trash";
const MANIFEST = ".manifest.json";

/** A session is a `<id>.jsonl` file plus an optional `<id>/` companion dir. */
function sessionIdOf(file: string): string {
  return basename(file, extname(file));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function trashDir(root: string): string {
  return join(root, TRASH_DIR);
}

function manifestPath(root: string): string {
  return join(trashDir(root), MANIFEST);
}

/** Read the trash manifest. A missing manifest is an empty one. */
async function readManifest(root: string): Promise<TrashEntry[]> {
  const path = manifestPath(root);
  if (!(await exists(path))) return [];
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value)) {
    throw new Error(`invalid trash manifest at ${path}`);
  }
  return value as TrashEntry[];
}

async function writeManifest(root: string, entries: TrashEntry[]): Promise<void> {
  await writeFile(manifestPath(root), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** Move the companion dir first, then the file; undo the dir move if the file fails.
 * Existing destination pairs are replaced (Explorer-style paste-over). */
async function relocatePair(srcFile: string, destFile: string, destCompanion: string): Promise<void> {
  const id = sessionIdOf(srcFile);
  const companion = join(dirname(srcFile), id);
  await mkdir(dirname(destFile), { recursive: true });
  // Windows rename fails (EPERM) when the destination exists, even as a dir
  await rm(destFile, { force: true });
  await rm(destCompanion, { recursive: true, force: true });

  let movedDir = false;
  try {
    if (await exists(companion)) {
      await rename(companion, destCompanion);
      movedDir = true;
    }
    await rename(srcFile, destFile);
  } catch (err) {
    if (movedDir) {
      try {
        await rename(destCompanion, companion);
      } catch {
        // keep the original error
      }
    }
    throw err;
  }
}

/** Create a folder, including any missing parents. */
export async function createFolder(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Copy a `<id>.jsonl` + optional `<id>/` pair into destDir. The source stays put. */
export async function copySession(srcFile: string, destDir: string): Promise<void> {
  const id = sessionIdOf(srcFile);
  const companion = join(dirname(srcFile), id);
  await mkdir(destDir, { recursive: true });
  await cp(srcFile, join(destDir, basename(srcFile)));
  if (await exists(companion)) {
    await cp(companion, join(destDir, id), { recursive: true });
  }
}

/** Move a `<id>.jsonl` + optional `<id>/` pair into destDir as one unit. */
export async function moveSession(srcFile: string, destDir: string): Promise<void> {
  const id = sessionIdOf(srcFile);
  await relocatePair(srcFile, join(destDir, basename(srcFile)), join(destDir, id));
}

/** Move a session pair into `root/.trash/` and record how to restore it. */
export async function deleteToTrash(root: string, sessionFile: string): Promise<void> {
  const id = sessionIdOf(sessionFile);
  const originalRelativePath = relative(root, sessionFile);
  await moveSession(sessionFile, trashDir(root));

  const entries = await readManifest(root);
  entries.push({ id, originalRelativePath, deletedAt: new Date().toISOString() });
  await writeManifest(root, entries);
}

/** Move a trashed pair back to its recorded path and drop the manifest entry. */
export async function restoreFromTrash(root: string, sessionId: string): Promise<void> {
  const entries = await readManifest(root);
  const index = entries.findIndex((entry) => entry.id === sessionId);
  if (index === -1) {
    throw new Error(`no trash entry for session ${sessionId}`);
  }
  const entry = entries[index];

  const destFile = join(root, entry.originalRelativePath);
  const destDir = dirname(destFile);
  const tdir = trashDir(root);
  await relocatePair(join(tdir, `${sessionId}.jsonl`), destFile, join(destDir, sessionId));

  entries.splice(index, 1);
  await writeManifest(root, entries);
}

/** Permanently clear the trash, then recreate an empty `.trash/`. */
export async function emptyTrash(root: string): Promise<void> {
  const tdir = trashDir(root);
  await rm(tdir, { recursive: true, force: true });
  await mkdir(tdir, { recursive: true });
}

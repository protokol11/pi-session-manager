// Headless unit tests for ops. Run: node --test test/ops.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copySession,
  createFolder,
  deleteToTrash,
  emptyTrash,
  moveSession,
  restoreFromTrash,
} from "../ops.ts";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a `<id>.jsonl` + `<id>/` pair with one nested child session. */
async function makePair(dir, id) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `{"type":"session","id":"${id}"}\n`);
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, "child.jsonl"), `{"type":"session","id":"child"}\n`);
}

function tempRoot(t) {
  return mkdtemp(join(tmpdir(), "ops-")).then((root) => {
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
  });
}

test("createFolder creates the directory", async (t) => {
  const root = await tempRoot(t);
  const dir = join(root, "nested", "folder");
  await createFolder(dir);
  assert.ok(await exists(dir));
});

test("moveSession moves both the .jsonl and the companion dir", async (t) => {
  const root = await tempRoot(t);
  const src = join(root, "src");
  const dest = join(root, "dest");
  const file = join(src, "a.jsonl");
  await makePair(src, "a");

  await moveSession(file, dest);

  assert.ok(!(await exists(file)), "source file gone");
  assert.ok(!(await exists(join(src, "a"))), "source companion gone");
  assert.ok(await exists(join(dest, "a.jsonl")), "dest file present");
  assert.ok(await exists(join(dest, "a", "child.jsonl")), "dest companion present");
});

test("copySession copies the pair and leaves the original", async (t) => {
  const root = await tempRoot(t);
  const src = join(root, "src");
  const dest = join(root, "dest");
  const file = join(src, "a.jsonl");
  await makePair(src, "a");

  await copySession(file, dest);

  assert.ok(await exists(file), "original file stays");
  assert.ok(await exists(join(src, "a", "child.jsonl")), "original companion stays");
  assert.ok(await exists(join(dest, "a.jsonl")), "dest file present");
  assert.ok(await exists(join(dest, "a", "child.jsonl")), "dest companion present");
});

test("deleteToTrash moves the pair and records a manifest entry", async (t) => {
  const root = await tempRoot(t);
  const proj = join(root, "--proj--");
  const file = join(proj, "a.jsonl");
  await makePair(proj, "a");

  await deleteToTrash(root, file);

  assert.ok(!(await exists(file)), "source file gone");
  assert.ok(!(await exists(join(proj, "a"))), "source companion gone");
  assert.ok(await exists(join(root, ".trash", "a.jsonl")), "trashed file present");
  assert.ok(await exists(join(root, ".trash", "a", "child.jsonl")), "trashed companion present");

  const manifest = JSON.parse(await readFile(join(root, ".trash", ".manifest.json"), "utf8"));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].id, "a");
  assert.equal(manifest[0].originalRelativePath, join("--proj--", "a.jsonl"));
  assert.ok(typeof manifest[0].deletedAt === "string" && manifest[0].deletedAt.length > 0);
});

test("deleteToTrash appends without clobbering earlier entries", async (t) => {
  const root = await tempRoot(t);
  const proj = join(root, "--proj--");
  await makePair(proj, "a");
  await makePair(proj, "b");

  await deleteToTrash(root, join(proj, "a.jsonl"));
  await deleteToTrash(root, join(proj, "b.jsonl"));

  const manifest = JSON.parse(await readFile(join(root, ".trash", ".manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.map((entry) => entry.id).sort(),
    ["a", "b"],
  );
});

test("restoreFromTrash returns the pair and clears its entry", async (t) => {
  const root = await tempRoot(t);
  const proj = join(root, "--proj--");
  const file = join(proj, "a.jsonl");
  await makePair(proj, "a");
  await deleteToTrash(root, file);

  await restoreFromTrash(root, "a");

  assert.ok(await exists(file), "file restored");
  assert.ok(await exists(join(proj, "a", "child.jsonl")), "companion restored");
  assert.ok(!(await exists(join(root, ".trash", "a.jsonl"))), "trash copy gone");

  const manifest = JSON.parse(await readFile(join(root, ".trash", ".manifest.json"), "utf8"));
  assert.equal(manifest.length, 0);
});

test("restoreFromTrash throws on an unknown session", async (t) => {
  const root = await tempRoot(t);
  await mkdir(join(root, ".trash"), { recursive: true });
  await writeFile(join(root, ".trash", ".manifest.json"), "[]\n");
  await assert.rejects(() => restoreFromTrash(root, "missing"), /no trash entry/);
});

test("emptyTrash clears .trash and recreates it empty", async (t) => {
  const root = await tempRoot(t);
  const proj = join(root, "--proj--");
  await makePair(proj, "a");
  await deleteToTrash(root, join(proj, "a.jsonl"));

  await emptyTrash(root);

  assert.ok(await exists(join(root, ".trash")), ".trash exists again");
  assert.deepEqual(await readdir(join(root, ".trash")), []);
});

test("copySession copies the pair and keeps the source; moveSession relocates it", async (t) => {
  const root = await tempRoot(t);
  const srcDir = join(root, "--src--");
  const destDir = join(root, "--dest--");
  await makePair(srcDir, "a");

  await copySession(join(srcDir, "a.jsonl"), destDir);
  assert.ok(await exists(join(destDir, "a.jsonl")), "copy: file present");
  assert.ok(await exists(join(destDir, "a", "child.jsonl")), "copy: companion dir present");
  assert.ok(await exists(join(srcDir, "a.jsonl")), "copy: source kept");

  await moveSession(join(srcDir, "a.jsonl"), destDir);
  assert.ok(!(await exists(join(srcDir, "a.jsonl"))), "move: source file gone");
  assert.ok(!(await exists(join(srcDir, "a"))), "move: source companion gone");
  assert.ok(await exists(join(destDir, "a.jsonl")), "move: file present at target");
  assert.ok(await exists(join(destDir, "a", "child.jsonl")), "move: companion present at target");
});

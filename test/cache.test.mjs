// Headless unit tests for the safe JSON cache writer/reader.
// Run: node --test test/cache.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonSafe, writeJsonSafe } from "../cache.ts";

test("writeJsonSafe then readJsonSafe round-trips the value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  const file = join(dir, "value.json");
  const value = { a: 1, nested: { b: [true, null, "x"] } };
  await writeJsonSafe(file, value);
  assert.deepEqual(await readJsonSafe(file), value);
});

test("readJsonSafe: missing file returns undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  assert.equal(await readJsonSafe(join(dir, "nope.json")), undefined);
});

test("readJsonSafe: malformed JSON returns undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  const file = join(dir, "bad.json");
  writeFileSync(file, "{not json", "utf8");
  assert.equal(await readJsonSafe(file), undefined);
});

test("writeJsonSafe: 50 concurrent writes to one path do not reject and last wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  const file = join(dir, "concurrent.json");
  const writes = [];
  for (let i = 0; i < 50; i++) writes.push(writeJsonSafe(file, { n: i }));
  await assert.doesNotReject(() => Promise.all(writes));
  assert.deepEqual(await readJsonSafe(file), { n: 49 });
});

test("writeJsonSafe: no temp files left behind after the batch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  const file = join(dir, "clean.json");
  const writes = [];
  for (let i = 0; i < 50; i++) writes.push(writeJsonSafe(file, { n: i }));
  await Promise.all(writes);
  const entries = readdirSync(dir);
  assert.deepEqual(entries, ["clean.json"]);
});

test("writeJsonSafe: a failed write rejects instead of hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  const blocked = join(dir, "target-is-a-dir");
  mkdirSync(blocked); // rename(tmp, existing-dir) must fail
  await assert.rejects(() => writeJsonSafe(blocked, { a: 1 }));
  // the queue must not be permanently stuck for other paths
  const ok = join(dir, "ok.json");
  await writeJsonSafe(ok, { a: 1 });
  assert.deepEqual(await readJsonSafe(ok), { a: 1 });
});

test("writeJsonSafe: creates the parent directory when missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-cache-"));
  const file = join(dir, "nested", "deeper", "value.json");
  await writeJsonSafe(file, { ok: true });
  assert.deepEqual(await readJsonSafe(file), { ok: true });
});

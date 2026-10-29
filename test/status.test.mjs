// Headless unit tests for the failure-autopilot status index (V005).
// Run: node --test test/status.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFile,
  classifyTail,
  loadStatusIndex,
  lookupStatus,
  readTail,
  saveStatusIndex,
  TAIL_CAP_BYTES,
} from "../status.ts";

const HEADER = JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "C:\\p" });
const USER_MSG = JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });
const ERROR_REC = JSON.stringify({ type: "message", message: { role: "assistant", error: { message: "boom" } } });

function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "ss-status-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, content, "utf8");
  return file;
}

test("readTail caps bytes read from EOF", () => {
  const big = `${HEADER}\n` + `${USER_MSG}\n`.repeat(20_000); // ~500KB
  const file = tmpFile(big);
  const tail = readTail(file);
  assert.ok(Buffer.byteLength(tail) <= TAIL_CAP_BYTES, "tail read is capped");
  assert.ok(tail.endsWith("\n"), "tail reaches EOF");
  assert.ok(!tail.startsWith(HEADER), "tail did not read from the start");
});

test("classifyTail: complete file ending in a normal record is ok", () => {
  assert.deepEqual(classifyTail(`${HEADER}\n${USER_MSG}\n`), { status: "ok" });
});

test("classifyTail: crash-killed file without trailing newline is killed", () => {
  const result = classifyTail(`${HEADER}\n${USER_MSG}\n{"type":"message","message":{"role":"assis`);
  assert.equal(result.status, "killed");
});

test("classifyTail: error record is error with extracted text", () => {
  const result = classifyTail(`${HEADER}\n${ERROR_REC}\n`);
  assert.equal(result.status, "error");
  assert.equal(result.error, "boom");
});

test("classifyTail: malformed last complete line is unknown", () => {
  assert.deepEqual(classifyTail(`${HEADER}\nnot-json at all\n`), { status: "unknown" });
});

test("classifyTail: empty tail is unknown", () => {
  assert.deepEqual(classifyTail(""), { status: "unknown" });
  assert.deepEqual(classifyTail("  \n"), { status: "unknown" });
});

test("classifyTail: killed beats error signal on the last complete record", () => {
  const result = classifyTail(`${HEADER}\n${ERROR_REC}\n{"partial`);
  assert.equal(result.status, "killed");
  assert.equal(result.error, "boom");
});

test("classifyFile reads at most the tail cap and classifies", () => {
  const big = `${HEADER}\n` + `${USER_MSG}\n`.repeat(20_000) + `${ERROR_REC}\n`;
  const file = tmpFile(big);
  assert.equal(classifyFile(file).status, "error");
  assert.equal(classifyFile(tmpFile(`${HEADER}\n{"partial`)).status, "killed");
  assert.equal(classifyFile(join(tmpdir(), "does-not-exist.jsonl")).status, "unknown");
});

test("sidecar round-trips and writes via temp + rename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-sidecar-"));
  const file = join(dir, ".status.json");
  const index = { "/p/a.jsonl": { mtimeMs: 1, size: 2, status: "killed", error: "x" } };
  await saveStatusIndex(file, index);
  assert.deepEqual(await loadStatusIndex(file), index);
  assert.ok(!existsSync(`${file}.tmp`), "no temp file left behind");
  // the written content is valid JSON on the final name
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), index);
});

test("sidecar mtime or size change invalidates the cached status", () => {
  const index = { "/p/a.jsonl": { mtimeMs: 1, size: 2, status: "error" } };
  assert.equal(lookupStatus(index, "/p/a.jsonl", 1, 2)?.status, "error");
  assert.equal(lookupStatus(index, "/p/a.jsonl", 2, 2), undefined, "mtime change invalidates");
  assert.equal(lookupStatus(index, "/p/a.jsonl", 1, 3), undefined, "size change invalidates");
  assert.equal(lookupStatus(index, "/p/other.jsonl", 1, 2), undefined, "path mismatch");
});

test("sidecar: a missing or malformed file loads as an empty index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-sidecar-"));
  assert.deepEqual(await loadStatusIndex(join(dir, "nope.json")), {});
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json", "utf8");
  assert.deepEqual(await loadStatusIndex(bad), {});
});

test("sidecar entry validation rejects malformed records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-sidecar-"));
  const file = join(dir, "mixed.json");
  writeFileSync(file, JSON.stringify({
    good: { mtimeMs: 1, size: 1, status: "ok" },
    badStatus: { mtimeMs: 1, size: 1, status: "weird" },
    badMtime: { mtimeMs: "1", size: 1, status: "ok" },
  }), "utf8");
  const index = await loadStatusIndex(file);
  assert.deepEqual(Object.keys(index), ["good"]);
});

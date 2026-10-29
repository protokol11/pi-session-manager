// Headless unit tests for the bounded session header read and the incremental
// metadata cache. Run: node --test test/meta-cache.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  mkdtempSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionHeader, readSessionMetaCached } from "../metadata.ts";
import { META_FILE, loadMetaCache, saveMetaCache } from "../meta-cache.ts";

function tmpFile(name = "session.jsonl") {
  const dir = mkdtempSync(join(tmpdir(), "ss-meta-cache-"));
  return join(dir, name);
}

function msgLine(content) {
  return JSON.stringify({ type: "message", message: { role: "user", content } }) + "\n";
}

function infoLine(name) {
  return JSON.stringify({ type: "session_info", name }) + "\n";
}

test("readSessionHeader reads id/cwd/parentSession past a huge body", () => {
  const file = tmpFile();
  const header = { type: "session", id: "h1", cwd: "/tmp/x", parentSession: "parent-1" };
  const huge = JSON.stringify({
    type: "message",
    message: { role: "user", content: "x".repeat(20000) },
  });
  writeFileSync(file, JSON.stringify(header) + "\n" + huge + "\n", "utf8");
  assert.deepEqual(readSessionHeader(file), {
    id: "h1",
    cwd: "/tmp/x",
    parentSession: "parent-1",
  });
});

test("readSessionHeader omits parentSession when absent", () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ type: "session", id: "h2", cwd: "/y" }) + "\n", "utf8");
  assert.deepEqual(readSessionHeader(file), { id: "h2", cwd: "/y" });
});

test("readSessionMetaCached cold read computes name/lastModel/totalChars/contextPercent", () => {
  const file = tmpFile();
  const lines = [
    JSON.stringify({ type: "session", id: "s", cwd: "/x" }) + "\n",
    msgLine("hello"), // 5
    infoLine("n1"),
    JSON.stringify({ type: "model_change", provider: "prov", modelId: "m" }) + "\n",
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "world" }, { type: "thinking", thinking: "hmm" }],
      },
    }) + "\n", // 5 + 3
  ];
  writeFileSync(file, lines.join(""), "utf8");
  const cache = {};
  const meta = readSessionMetaCached(file, 100, cache);
  assert.equal(meta.name, "n1");
  assert.equal(meta.lastModel, "prov/m");
  // totalChars = 5 + 5 + 3 = 13; 13/4/100*100 = 3.25 -> 3
  assert.equal(meta.contextPercent, 3);
  assert.equal(cache[file].totalChars, 13);
  assert.equal(cache[file].name, "n1");
  assert.equal(cache[file].lastModel, "prov/m");
  assert.equal(cache[file].cachedBytes, statSync(file).size);
});

test("readSessionMetaCached delta append counts message chars and updates name", () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ type: "session", id: "s", cwd: "/x" }) + "\n" + msgLine("hello"), "utf8");
  const cache = {};
  readSessionMetaCached(file, undefined, cache);
  const before = cache[file].totalChars;

  appendFileSync(file, msgLine("abcdefghij"), "utf8"); // +10
  let meta = readSessionMetaCached(file, undefined, cache);
  assert.equal(cache[file].totalChars, before + 10);
  assert.equal(meta.contextPercent, undefined);

  appendFileSync(file, infoLine("new-name"), "utf8");
  meta = readSessionMetaCached(file, undefined, cache);
  assert.equal(meta.name, "new-name");
  assert.equal(cache[file].totalChars, before + 10);
});

test("readSessionMetaCached defers a partial line until its newline arrives", () => {
  const file = tmpFile();
  writeFileSync(file, msgLine("hello"), "utf8");
  const cache = {};
  readSessionMetaCached(file, undefined, cache);
  const beforeChars = cache[file].totalChars;
  const beforeCached = cache[file].cachedBytes;

  const line = JSON.stringify({ type: "message", message: { role: "user", content: "partial!!!" } });
  appendFileSync(file, line.slice(0, 5), "utf8"); // no trailing newline
  readSessionMetaCached(file, undefined, cache);
  assert.equal(cache[file].totalChars, beforeChars);
  assert.equal(cache[file].cachedBytes, beforeCached);

  appendFileSync(file, line.slice(5) + "\n", "utf8");
  readSessionMetaCached(file, undefined, cache);
  assert.equal(cache[file].totalChars, beforeChars + "partial!!!".length);
  assert.equal(cache[file].cachedBytes, statSync(file).size);
});

test("readSessionMetaCached full recompute after truncation", () => {
  const file = tmpFile();
  const big = infoLine("first") + msgLine("a".repeat(500));
  writeFileSync(file, big, "utf8");
  const cache = {};
  assert.equal(readSessionMetaCached(file, undefined, cache).name, "first");

  // rewrite smaller with a different name
  const small = infoLine("truncated") + "\n";
  writeFileSync(file, small, "utf8");
  const meta = readSessionMetaCached(file, undefined, cache);
  assert.equal(meta.name, "truncated");
  assert.equal(cache[file].totalChars, 0);
  assert.ok(cache[file].size < Buffer.byteLength(big));
});

test("readSessionMetaCached full recompute on same size but changed mtime", () => {
  const file = tmpFile();
  const c1 = infoLine("aaaaa");
  const c2 = infoLine("bbbbb");
  assert.equal(c1.length, c2.length); // same byte size
  writeFileSync(file, c1, "utf8");
  const cache = {};
  assert.equal(readSessionMetaCached(file, undefined, cache).name, "aaaaa");

  writeFileSync(file, c2, "utf8");
  // force a distinct mtime so the (same size) change is detected
  const forced = new Date(Date.now() + 60_000);
  utimesSync(file, forced, forced);
  assert.equal(readSessionMetaCached(file, undefined, cache).name, "bbbbb");
});

test("loadMetaCache/saveMetaCache round-trip and missing -> {}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-meta-cache-"));
  const file = join(dir, META_FILE);
  assert.deepEqual(await loadMetaCache(file), {});

  const cache = {
    "/x/s.jsonl": { mtimeMs: 1, size: 2, cachedBytes: 3, totalChars: 4, name: "n", lastModel: "p/m" },
    "/y/t.jsonl": { mtimeMs: 5, size: 6, cachedBytes: 0, totalChars: 7 },
  };
  await saveMetaCache(file, cache);
  assert.deepEqual(await loadMetaCache(file), cache);
});

test("loadMetaCache drops malformed and invalid-shape entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-meta-cache-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json", "utf8");
  assert.deepEqual(await loadMetaCache(bad), {});

  const mixed = join(dir, "mixed.json");
  writeFileSync(
    mixed,
    JSON.stringify({
      good: { mtimeMs: 1, size: 2, cachedBytes: 3, totalChars: 4 },
      missingFields: { mtimeMs: 1, size: 2 },
      wrongType: { mtimeMs: "1", size: 2, cachedBytes: 3, totalChars: 4 },
      notObject: 42,
    }),
    "utf8",
  );
  assert.deepEqual(await loadMetaCache(mixed), {
    good: { mtimeMs: 1, size: 2, cachedBytes: 3, totalChars: 4 },
  });
});

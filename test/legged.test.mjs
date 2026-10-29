// Headless unit tests for legged.scanHandoffs. Run: node --test test/legged.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { scanHandoffs } from "../legged.ts";

const CWD = fileURLToPath(new URL("./fixtures/legged", import.meta.url));

test("only the file with a sessionId is mapped", async () => {
  const map = await scanHandoffs(CWD);
  assert.equal(map.size, 1);
  assert.ok(map.has("sess-123"));
  assert.ok(!map.has("without-id"));
});

test("the mapped path is relative to cwd", async () => {
  const map = await scanHandoffs(CWD);
  assert.equal(map.get("sess-123"), join(".docs", "handoff", "with-id.md"));
});

test("a missing handoff directory yields an empty map", async () => {
  const map = await scanHandoffs(join(CWD, "does-not-exist"));
  assert.equal(map.size, 0);
});

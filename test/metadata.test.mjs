// Headless unit tests for metadata. Run: node --test test/metadata.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readSessionHeader, readSessionMeta } from "../metadata.ts";

const SAMPLE = fileURLToPath(new URL("./fixtures/sample.jsonl", import.meta.url));

test("readSessionHeader returns id and cwd", () => {
  assert.deepEqual(readSessionHeader(SAMPLE), {
    id: "sample-id",
    cwd: "C:\\Users\\HOME\\proj",
  });
});

test("name comes from the last session_info record", () => {
  assert.equal(readSessionMeta(SAMPLE).name, "my-name");
});

test("lastModel is provider/modelId", () => {
  assert.equal(readSessionMeta(SAMPLE).lastModel, "prov/m1");
});

test("contextPercent on a fixed window", () => {
  // totalChars = "hello" (5) + "world" (5) + "hmm" (3) = 13
  // 13 / 4 = 3.25 chars-per-token; 3.25 / 100 * 100 = 3.25 -> round 3
  assert.equal(readSessionMeta(SAMPLE, 100).contextPercent, 3);
});

test("missing contextWindow leaves contextPercent undefined", () => {
  assert.equal(readSessionMeta(SAMPLE).contextPercent, undefined);
});

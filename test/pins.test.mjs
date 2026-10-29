// Headless unit tests for the Quick access pins module.
// Run: node --test test/pins.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPins, savePins, togglePin } from "../pins.ts";

test("togglePin appends when absent and removes when present", () => {
  assert.deepEqual(togglePin([], "/a"), ["/a"]);
  assert.deepEqual(togglePin(["/a"], "/b"), ["/a", "/b"]);
  assert.deepEqual(togglePin(["/a", "/b"], "/a"), ["/b"]);
});

test("loadPins: missing or malformed file is an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pins-"));
  try {
    assert.deepEqual(await loadPins(join(dir, "nope.json")), []);
    await savePins(join(dir, "pins.json"), ["/a", 7, "/b"]);
    const file = join(dir, "pins.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{not json", "utf8");
    assert.deepEqual(await loadPins(file), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePins/loadPins roundtrip keeps order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pins-"));
  try {
    const file = join(dir, "pins.json");
    await savePins(file, ["/b", "/a"]);
    assert.deepEqual(await loadPins(file), ["/b", "/a"]);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(raw.paths, ["/b", "/a"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

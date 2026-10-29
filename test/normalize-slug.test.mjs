// Headless unit tests for normalizeSlug. Run: node --test test/normalize-slug.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSlug } from "../normalize-slug.ts";

test("sentence → verb-led slug", () => {
  assert.equal(normalizeSlug("Drill session manager naming"), "drill-session-manager-naming");
});

test("underscores + punctuation collapse to hyphens", () => {
  assert.equal(normalizeSlug("Fix/ss-render stuck_arrow!"), "fix-ss-render-stuck-arrow");
});

test("uppercase neutralized", () => {
  assert.equal(normalizeSlug("ABC Def"), "abc-def");
});

test("trims and collapses hyphen runs", () => {
  assert.equal(normalizeSlug("  --Research   pi session--format  "), "research-pi-session-format");
});

test("empty / garbage → empty slug", () => {
  assert.equal(normalizeSlug(""), "");
  assert.equal(normalizeSlug("!!!"), "");
});

test("soft-caps at 64 chars and re-trims trailing hyphen", () => {
  const long = "a".repeat(80);
  assert.equal(normalizeSlug(long).length, 64);
  assert.equal(normalizeSlug("x".repeat(63) + "---"), "x".repeat(63));
});

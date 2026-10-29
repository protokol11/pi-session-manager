// Headless unit tests for the render seam. Run: node --test test/list-component.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderList } from "../list-component.ts";

test("unnamed → error color + (unnamed) placeholder", () => {
  const [line] = renderList([{ name: undefined, lastModel: "a/b", contextPercent: 10 }], { visibleWidth: 40 });
  assert.equal(line.color, "error");
  assert.ok(line.text.includes("(unnamed)"));
});

test("named → default color", () => {
  const [line] = renderList([{ name: "drill-session-manager" }], { visibleWidth: 40 });
  assert.equal(line.color, "default");
  assert.ok(line.text.startsWith("drill-session-manager"));
});

test("contextPercent undefined → ?%", () => {
  const [line] = renderList([{ name: "x", contextPercent: undefined }], { visibleWidth: 40 });
  assert.ok(line.text.includes("?%"));
});

test("every line length === visibleWidth (real width, not width-1)", () => {
  const lines = renderList(
    [
      { name: "short" },
      { name: "a-very-long-name-that-exceeds-the-width-for-sure-and-then-some" },
      { name: "x", contextPercent: 7 },
    ],
    { visibleWidth: 32 },
  );
  for (const line of lines) assert.equal(line.text.length, 32);
});

test("legged → line contains <legged> and path", () => {
  const [line] = renderList([{ name: "x", legged: ".docs/handoff/h.md" }], { visibleWidth: 60 });
  assert.ok(line.text.includes("<legged>"));
  assert.ok(line.text.includes(".docs/handoff/h.md"));
});

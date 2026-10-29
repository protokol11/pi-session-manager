// Headless unit tests for the TELEPORT input DFA.
// Run: node --test test/teleport.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  browse,
  TELEPORT_MAX,
  teleportBackspace,
  teleportCancel,
  teleportInput,
  teleportMatches,
  teleportOpen,
  teleportResolve,
} from "../teleport.ts";

const row = (kind, name, path = `/p/${name}`, project = "proj") => ({
  key: path,
  kind,
  depth: 0,
  name,
  path,
  project,
});

test("browse starts inactive; open enters TELEPORT with empty text", () => {
  assert.deepEqual(browse(), { active: false, text: "" });
  assert.deepEqual(teleportOpen(), { active: true, text: "" });
});

test("input appends one printable char; control sequences ignored", () => {
  let st = teleportOpen();
  st = teleportInput(st, "a");
  st = teleportInput(st, "b");
  assert.equal(st.text, "ab");
  assert.equal(teleportInput(st, "\x1b").text, "ab", "escape sequence ignored");
  assert.equal(teleportInput(st, "\n").text, "ab", "newline ignored");
});

test("input is a no-op in BROWSE state", () => {
  assert.equal(teleportInput(browse(), "a").text, "");
});

test("input respects TELEPORT_MAX length cap", () => {
  let st = teleportOpen();
  for (let i = 0; i < TELEPORT_MAX + 10; i++) st = teleportInput(st, "x");
  assert.equal(st.text.length, TELEPORT_MAX);
});

test("backspace removes one char; empty stays empty; browse unaffected", () => {
  let st = teleportInput(teleportInput(teleportOpen(), "a"), "b");
  st = teleportBackspace(st);
  assert.equal(st.text, "a");
  st = teleportBackspace(st);
  assert.equal(st.text, "");
  assert.equal(teleportBackspace(st).text, "");
  assert.deepEqual(teleportBackspace(browse()), { active: false, text: "" });
});

test("cancel returns to BROWSE from any state", () => {
  const st = teleportInput(teleportOpen(), "x");
  assert.deepEqual(teleportCancel(st), { active: false, text: "" });
});

test("matches: case-insensitive prefix on session or project name", () => {
  const rows = [row("session", "Alpha"), row("session", "beta", "/p/beta", "frontend"), row("project", "proj")];
  assert.deepEqual(teleportMatches(rows, "al").map((r) => r.name), ["Alpha"]);
  assert.deepEqual(teleportMatches(rows, "FRONT").map((r) => r.name), ["beta"]);
  // project prefix matches the project row AND its sessions (match is on project too)
  assert.deepEqual(teleportMatches(rows, "pro").map((r) => r.name), ["Alpha", "proj"]);
});

test("resolve: inactive -> none", () => {
  assert.deepEqual(teleportResolve(browse(), [row("session", "a")]), { kind: "none" });
});

test("resolve: no match -> none (stays in TELEPORT, nothing changes)", () => {
  let st = teleportOpen();
  for (const ch of "zzz") st = teleportInput(st, ch);
  assert.deepEqual(teleportResolve(st, [row("session", "alpha")]), { kind: "none" });
});

test("resolve: first session match switches", () => {
  const st = teleportInput(teleportOpen(), "al");
  const action = teleportResolve(st, [row("session", "alpha", "/p/alpha.jsonl")]);
  assert.deepEqual(action, { kind: "switch", path: "/p/alpha.jsonl" });
});

test("resolve: child sessions switch too", () => {
  const st = teleportInput(teleportOpen(), "b");
  const action = teleportResolve(st, [row("child", "beta", "/p/b.jsonl")]);
  assert.deepEqual(action, { kind: "switch", path: "/p/b.jsonl" });
});

test("resolve: project match focuses the project", () => {
  const st = teleportInput(teleportOpen(), "pi");
  const action = teleportResolve(st, [row("project", "pi-orchestrator")]);
  assert.deepEqual(action, { kind: "focus-project", name: "pi-orchestrator" });
});

test("resolve: @n suffix on a session returns a lens action at depth n", () => {
  let st = teleportOpen();
  for (const ch of "alpha@3") st = teleportInput(st, ch);
  const action = teleportResolve(st, [row("session", "alpha", "/p/alpha.jsonl")]);
  assert.deepEqual(action, { kind: "lens", path: "/p/alpha.jsonl", depth: 3 });
});

test("resolve: @n works on child sessions too", () => {
  let st = teleportOpen();
  for (const ch of "b@2") st = teleportInput(st, ch);
  const action = teleportResolve(st, [row("child", "beta", "/p/b.jsonl")]);
  assert.deepEqual(action, { kind: "lens", path: "/p/b.jsonl", depth: 2 });
});

test("resolve: @0 and @x abstain — resolve to none", () => {
  for (const text of ["alpha@0", "alpha@x", "alpha@", "alpha@-1", "alpha@2.5"]) {
    let st = teleportOpen();
    for (const ch of text) st = teleportInput(st, ch);
    assert.deepEqual(
      teleportResolve(st, [row("session", "alpha", "/p/alpha.jsonl")]),
      { kind: "none" },
      `${text} must abstain`,
    );
  }
});

test("resolve: @n with no matching base row resolves to none", () => {
  let st = teleportOpen();
  for (const ch of "zzz@3") st = teleportInput(st, ch);
  assert.deepEqual(teleportResolve(st, [row("session", "alpha")]), { kind: "none" });
});

test("resolve: no suffix keeps plain switch behavior", () => {
  let st = teleportOpen();
  for (const ch of "alpha") st = teleportInput(st, ch);
  assert.deepEqual(teleportResolve(st, [row("session", "alpha", "/p/alpha.jsonl")]), {
    kind: "switch",
    path: "/p/alpha.jsonl",
  });
});

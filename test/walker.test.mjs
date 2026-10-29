// Headless unit tests for walkStore. Run: node --test test/walker.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkStore, decodeStoreDir, descendantDepth, deriveAncestry, MAX_COMPANION_DEPTH } from "../walker.ts";

const STORE = fileURLToPath(new URL("./fixtures/store", import.meta.url));
const PROJECT = join(STORE, "--proj--");

test("decodeStoreDir round-trips a real path through the pi encoding", () => {
  const real = join(tmpdir(), "dec-ode цифra test"); // literal hyphen + space
  mkdirSync(real, { recursive: true });
  try {
    const encoded = "--" + real.replace(/[/\\:]+/g, "-") + "--";
    assert.equal(decodeStoreDir(encoded), real);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
  assert.equal(decodeStoreDir("--Z--no-such-path-anywhere--"), undefined, "no segmentation exists");
  assert.equal(decodeStoreDir("--proj--"), undefined, "not a drive-prefixed store dir");
});

test("one project node at level 1", () => {
  const projects = walkStore(STORE);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "--proj--");
  assert.equal(projects[0].path, PROJECT);
});

test("session a is found with companion child b", () => {
  const project = walkStore(STORE)[0];
  const a = project.sessions.find((s) => s.id === "a");
  assert.ok(a, "session a present");
  assert.equal(a.name, "alpha");
  assert.equal(a.path, join(PROJECT, "a.jsonl"));
  assert.equal(a.children.length, 2);
  assert.deepEqual(
    a.children.map((c) => c.id).sort(),
    ["b", "run-x-child"],
    "flat companion jsonl and run-layout session are both children",
  );
  assert.equal(a.children[0].id, "b");
});

test("folder sub holds c, and c is not a project session", () => {
  const project = walkStore(STORE)[0];
  const sub = project.folders.find((f) => f.name === "sub");
  assert.ok(sub, "folder sub present");
  assert.equal(sub.path, join(PROJECT, "sub"));
  assert.ok(!project.sessions.some((s) => s.id === "c"));
  assert.equal(sub.sessions.length, 1, "folder enumerates its sessions");
  assert.equal(sub.sessions[0].id, "c");
});

test("subagent-artifacts and .hidden are skipped", () => {
  const project = walkStore(STORE)[0];
  assert.ok(!project.folders.some((f) => f.name === "subagent-artifacts"));
  assert.ok(!project.folders.some((f) => f.name === ".hidden"));
  assert.ok(!project.sessions.some((s) => s.id === "junk"));
  assert.ok(!project.sessions.some((s) => s.id === "hidden"));
});

test(".trash becomes trash, not a session or folder", () => {
  const project = walkStore(STORE)[0];
  assert.ok(project.trash, "trash present");
  assert.equal(project.trash.path, join(PROJECT, ".trash"));
  assert.ok(!project.folders.some((f) => f.name === ".trash"));
  assert.ok(!project.sessions.some((s) => s.id === "trash"));
});

// --- V006: lineage derivation rules (path nesting only, nothing invented) ---

test("descendantDepth derives nesting from path ancestry within the shared guard", () => {
  const project = walkStore(STORE)[0];
  const a = project.sessions.find((s) => s.id === "a");
  const b = a.children.find((c) => c.id === "b");
  const runChild = a.children.find((c) => c.id === "run-x-child");
  const c = project.folders.find((f) => f.name === "sub").sessions[0];

  assert.equal(descendantDepth(a.path, b.path), 1, "companion file nests one step under the stem");
  assert.equal(descendantDepth(a.path, runChild.path), 3, "run layout nests three steps");
  assert.equal(descendantDepth(a.path, a.path), -1, "a session is not its own descendant");
  assert.equal(descendantDepth(a.path, c.path), -1, "sibling folder branch is not a descendant");
  assert.equal(descendantDepth(b.path, a.path), -1, "ancestry never runs downward");

  // guard: a path nested deeper than MAX_COMPANION_DEPTH is not a descendant
  let deep = a.path;
  for (let i = 0; i < MAX_COMPANION_DEPTH + 2; i++) deep = join(deep, `d${i}`);
  const deepFile = join(deep, "session.jsonl");
  assert.equal(descendantDepth(a.path, deepFile), -1, "guard depth exceeded => not a descendant");
  const atGuard = join(a.path, "x", "y", "z");
  assert.ok(descendantDepth(a.path, atGuard) <= MAX_COMPANION_DEPTH, "shared guard caps accepted depth");
});

test("deriveAncestry walks the stem chain upward and stops at the store root", () => {
  const project = walkStore(STORE)[0];
  const a = project.sessions.find((s) => s.id === "a");
  const b = a.children.find((c) => c.id === "b");

  const top = deriveAncestry(a.path, STORE);
  assert.deepEqual(top, [], "a top-level session has no ancestry inside the project");

  const chain = deriveAncestry(b.path, STORE);
  assert.deepEqual(chain, [{ kind: "stem", path: a.path }], "companion child resolves its parent stem");
});

test("deriveAncestry renders a missing stem as a gap, never a crash or invented parent", () => {
  const project = walkStore(STORE)[0];
  const a = project.sessions.find((s) => s.id === "a");
  const runChild = a.children.find((c) => c.id === "run-x-child");

  // run-layout dirs have no stem siblings on disk => gap markers, and the
  // chain still bottoms out at the real a.jsonl stem
  const chain = deriveAncestry(runChild.path, STORE);
  assert.equal(chain[chain.length - 1].kind, "stem");
  assert.equal(chain[chain.length - 1].path, a.path);
  assert.ok(chain.slice(0, -1).every((s) => s.kind === "gap"), "missing stems are gaps, not crashes");
  assert.ok(chain.every((s) => s.kind !== "stem" || s.path === a.path), "no parent path invented beyond the disk");
});

test("walkStore with a WalkContext populates node metadata and reuses the cache", () => {
  const root = mkdtempSync(join(tmpdir(), "ss-walker-ctx-"));
  const proj = join(root, "--test-proj--");
  mkdirSync(proj, { recursive: true });
  const file = join(proj, "s1.jsonl");
  const NL = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  const cwd = "C:" + BS + "work";
  const lines = [
    JSON.stringify({ type: "session", id: "s1", cwd, parentSession: "p0" }) + NL,
    JSON.stringify({ type: "session_info", name: "my-session" }) + NL,
    JSON.stringify({ type: "model_change", provider: "prov", modelId: "m1" }) + NL,
    JSON.stringify({ type: "message", message: { role: "user", content: "hello world" } }) + NL,
  ];
  writeFileSync(file, lines.join(""), "utf8");
  try {
    const cache = {};
    const projects = walkStore(root, { cache, contextWindow: 128000 });
    const node = projects[0].sessions[0];
    assert.equal(node.id, "s1");
    assert.equal(node.cwd, cwd);
    assert.equal(node.name, "my-session");
    assert.equal(node.parentSessionPath, "p0");
    assert.equal(node.model, "prov/m1");
    assert.equal(typeof node.contextPercent, "number");
    assert.equal(typeof node.mtimeMs, "number");

    // second pass with the SAME cache: the entry was populated and sized to the file
    walkStore(root, { cache, contextWindow: 128000 });
    assert.equal(cache[file].cachedBytes, statSync(file).size);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveAncestry on malformed input yields nothing instead of guessing", () => {
  assert.deepEqual(deriveAncestry("", STORE), []);
  assert.deepEqual(deriveAncestry("no-dir-here.jsonl", ""), []);
});

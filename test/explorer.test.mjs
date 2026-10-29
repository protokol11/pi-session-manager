// Headless unit tests for the explorer view-model + three-pane renderer.
// Run: node --test test/explorer.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { walkStore } from "../walker.ts";
import {
  buildAddressBarPath,
  buildLensRows,
  buildNavEntries,
  buildSpineRows,
  descendantsOf,
  findProjectIndexByCwd,
  buildRecentRows,
  buildSearchRows,
  buildSessionRows,
  buildTreeRows,
  fit,
  LENS_MAX_DEPTH,
  midColumns,
  modAge,
  sortRows,
  paneWidths,
  renderExplorer,
  sortByMtime,
  transferChildrenOf,
  transferParentPaths,
} from "../explorer.ts";

const STORE = fileURLToPath(new URL("./fixtures/store", import.meta.url));

function visibleWidth(line) {
  return line.reduce((n, seg) => n + seg.text.length, 0);
}

const NOW = 1_000_000_000_000;

function navFixture() {
  return [
    { name: "Quick access", path: "__quick_access__", sessionCount: 0 },
    { name: "--proj--", path: "/p", sessionCount: 2 },
  ];
}

function sessionFixture(name, over = {}) {
  return {
    key: name,
    kind: "session",
    depth: 0,
    name,
    path: `/p/${name}.jsonl`,
    id: name,
    project: "--proj--",
    model: "glm-5.3",
    contextPercent: 61,
    mtime: NOW - 2 * 60000,
    ...over,
  };
}

function stateFixture(over = {}) {
  return {
    nav: navFixture(),
    rows: [sessionFixture("alpha"), sessionFixture("beta")],
    pane: "middle",
    selected: 0,
    detail: sessionFixture("alpha"),
    addressPath: ["--proj--"],
    mode: "tree",
    width: 100,
    height: 24,
    now: NOW,
    ...over,
  };
}

test("buildSessionRows copies model, contextPercent, and mtime from the node", () => {
  const node = {
    path: "/p/s.jsonl",
    id: "s",
    name: "sess",
    children: [],
    model: "prov/m",
    contextPercent: 42,
    mtimeMs: NOW,
  };
  const row = buildSessionRows([node], "P")[0];
  assert.equal(row.model, "prov/m");
  assert.equal(row.contextPercent, 42);
  assert.equal(row.mtime, NOW);
});

test("buildTreeRows lists folders and sessions; children only when pinned; no project row", () => {
  const projects = walkStore(STORE);
  const rows = buildTreeRows(projects, { focus: null, focusDepth: 0, pinned: new Set() });
  const kinds = rows.map((r) => `${r.kind}:${r.name}`);
  assert.ok(!kinds.some((k) => k.startsWith("project:")), "no redundant project row in the middle pane");
  assert.ok(kinds.includes("folder:sub"));
  assert.ok(kinds.includes("session:alpha"));
  assert.ok(!kinds.includes("child:b"), "child b hidden when not expanded");
  const c = rows.find((r) => r.id === "c");
  assert.ok(c, "folder session c enumerated");
  assert.equal(c.kind, "session");
  assert.equal(c.depth, 2);
  assert.equal(c.unnamed, true, "c has no name");
});

test("buildTreeRows expands a session's subagent children inline", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const rows = buildTreeRows(projects, { focus: null, focusDepth: 0, pinned: new Set([a.path]) });
  const b = rows.find((r) => r.kind === "child" && r.id === "b");
  assert.ok(b, "child b present when expanded");
  assert.equal(b.depth, 2);
});

test("walker recurses run dirs: <stem>/<runId>/run-0/session.jsonl becomes a child", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  assert.ok(a.children.some((c) => c.id === "run-x-child"), "run-layout session enumerated as child");
  const rows = buildTreeRows(projects, { focus: null, focusDepth: 0, pinned: new Set([a.path]) });
  const runChild = rows.find((r) => r.kind === "child" && r.id === "run-x-child");
  assert.ok(runChild, "run-layout child rendered when expanded");
});

test("walker falls back to the run dir name when a run session header is malformed", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const b = a.children.find((c) => c.id === "b");
  assert.equal(b.path.endsWith("b.jsonl"), true);
});

// --- Transfer lineage (ADR-0035) + mode toggle (amendment 2026-10-06) ---

function lineageFixture() {
  const parent = { path: "/p/parent.jsonl", id: "parent", name: "parent", children: [] };
  const child = {
    path: "/p/child.jsonl",
    id: "child",
    name: "child",
    children: [],
    parentSessionPath: parent.path,
  };
  const sub = { path: "/p/parent/run/x.jsonl", id: "sub", name: "sub", children: [] };
  parent.children = [sub];
  return {
    project: { path: "/p", name: "--p--", displayName: "p", sessions: [parent, child], folders: [] },
    parent,
    child,
    sub,
  };
}

test("buildTreeRows groups a parentSession child under its parent; dangling stays top-level", () => {
  const { project, parent, child } = lineageFixture();
  const rows = buildTreeRows([project], { focus: null, focusDepth: 0, pinned: new Set([parent.path]) });
  const transfer = rows.filter((r) => r.id === "child");
  assert.equal(transfer.length, 1, "transfer child renders once, not also at top level");
  assert.equal(transfer[0].kind, "child");
  assert.equal(transfer[0].link, "transfer");
  assert.equal(transfer[0].depth, 2);
  const subRow = rows.find((r) => r.id === "sub");
  assert.equal(subRow.link, "subagent", "subagent companions keep the subagent axis");
  assert.deepEqual(transferParentPaths([project]), new Set([parent.path]));
  assert.ok(transferChildrenOf([project]).get(parent.path).includes(child));

  const flat = buildTreeRows([project], { focus: null, focusDepth: 0, pinned: new Set() });
  assert.ok(
    flat.some((r) => r.id === "child" && r.kind === "session"),
    "with no pin the transfer child keeps its natural top-level slot",
  );
});

test("renderExplorer marks transfer and subagent children distinctly, and lists both mode keys", () => {
  const { project, parent } = lineageFixture();
  const rows = buildTreeRows([project], { focus: null, focusDepth: 0, pinned: new Set([parent.path]) }).map(
    (r) => ({ ...r, mtime: NOW, model: "m", contextPercent: 10 }),
  );
  const out = renderExplorer(stateFixture({ rows }));
  const text = out.map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("↦ child"), text);
  assert.ok(text.includes("⎇ sub"), text);
  assert.ok(text.includes("~/F4 tree"), "key-help lists both ~ and F4");
});

test("address bar always shows the [flat]/[tree] indicator", () => {
  assert.equal(
    buildAddressBarPath(["proj"], { name: "s" }, NOW, 0, false, "flat").left,
    "pi / proj / s  [flat]",
  );
  const flatBar = renderExplorer(stateFixture({ mode: "flat" }))[0].map((s) => s.text).join("");
  assert.ok(flatBar.includes("[flat]"), `bar: ${flatBar}`);
  const treeBar = renderExplorer(stateFixture({ mode: "tree" }))[0].map((s) => s.text).join("");
  assert.ok(treeBar.includes("[tree]"), `bar: ${treeBar}`);
});

test("buildRecentRows flattens sessions across projects and folders", () => {
  const rows = buildRecentRows(walkStore(STORE));
  assert.deepEqual(rows.map((r) => r.id), ["a", "c"]);
  assert.ok(rows.every((r) => r.kind === "session"));
});

test("buildNavEntries puts Quick access first, then projects", () => {
  const nav = buildNavEntries(walkStore(STORE));
  assert.equal(nav[0].name, "Quick access");
  assert.equal(nav[0].path, "__quick_access__");
  assert.equal(nav[1].name, "p", "display name = cwd basename from the session header");
  assert.equal(nav[1].sessionCount, 2);
  assert.equal(nav.length, 2);
});

test("buildNavEntries appends alias groups after the projects", () => {
  const groups = [
    { name: "mc", project: "--proj--", sessions: [{ path: "/p/a.jsonl", id: "a", children: [] }] },
  ];
  const nav = buildNavEntries(walkStore(STORE), groups);
  assert.equal(nav.length, 3);
  assert.equal(nav[0].name, "Quick access");
  assert.equal(nav[2].name, "mc");
  assert.equal(nav[2].path, "__alias__:--proj--");
  assert.equal(nav[2].sessionCount, 1);
  assert.equal(nav[2].alias, true);
});

test("findProjectIndexByCwd matches the majority cwd, case-insensitive on Windows", () => {
  const projects = walkStore(STORE); // fixture cwd is C:\p
  assert.equal(findProjectIndexByCwd(projects, "C:\\p"), 0);
  assert.equal(findProjectIndexByCwd(projects, "c:\\P"), 0, "resolved + lowercased on win32");
  assert.equal(findProjectIndexByCwd(projects, "D:\\elsewhere"), -1, "no match → caller stays on Quick access");
});

test("sortByMtime orders most-recent first, missing mtime last", () => {
  const rows = [
    { key: "1", kind: "session", depth: 0, name: "old", path: "1", mtime: 100 },
    { key: "2", kind: "session", depth: 0, name: "new", path: "2", mtime: 999 },
    { key: "3", kind: "session", depth: 0, name: "unknown", path: "3" },
  ];
  const sorted = sortByMtime(rows);
  assert.deepEqual(sorted.map((r) => r.name), ["new", "old", "unknown"]);
});

test("fit truncates with ellipsis and pads to exact width", () => {
  const short = fit([{ text: "ab", color: "default" }], 5);
  assert.equal(visibleWidth(short), 5);

  const long = fit([{ text: "abcdefghij", color: "default" }], 4);
  assert.equal(visibleWidth(long), 4);
  assert.ok(long[0].text.endsWith("…"));
});

test("modAge renders m/h/d", () => {
  assert.equal(modAge(NOW - 2 * 60000, NOW), "2m");
  assert.equal(modAge(NOW - 3 * 3600000, NOW), "3h");
  assert.equal(modAge(NOW - 50 * 3600000, NOW), "2d");
});

test("buildAddressBarPath: project chain + session name + mod age", () => {
  const bar = buildAddressBarPath(["proj"], { name: "sess", mtime: NOW - 2 * 60000 }, NOW);
  assert.equal(bar.left, "pi / proj / sess");
  assert.equal(bar.right, "mod 2m ago");
});

test("buildAddressBarPath: no session -> project only, empty right", () => {
  const bar = buildAddressBarPath(["proj"], undefined, NOW);
  assert.equal(bar.left, "pi / proj");
  assert.equal(bar.right, "");
});

test("buildAddressBarPath: unnamed session pins the id tail", () => {
  const bar = buildAddressBarPath(["proj"], { id: "abcd-123456", mtime: NOW }, NOW);
  assert.equal(bar.left, "pi / proj / (unnamed)·123456");
});

test("paneWidths: three panes account for 4 separators; right dies first", () => {
  const wide = paneWidths(100, true);
  assert.equal(wide.wLeft + wide.wMid + wide.wRight + 4, 100);
  assert.ok(wide.wRight >= 24);
  assert.ok(wide.wMid >= 24);

  const narrow = paneWidths(48, true);
  assert.equal(narrow.wRight, 0, "details pane collapses first at width 48");
  assert.ok(narrow.wMid >= 24);
  assert.equal(narrow.wLeft + narrow.wMid + 3, 48);
});

test("midColumns: MOD dies first, then MODEL; NAME and CTX% survive", () => {
  const all = midColumns(50);
  assert.ok(all.name >= 8 && all.model === 10 && all.mod === 4 && all.ctx === 5);

  const noMod = midColumns(30);
  assert.equal(noMod.mod, 0);
  assert.ok(noMod.name >= 8 && noMod.model > 0);

  const onlyName = midColumns(24);
  assert.equal(onlyName.mod, 0);
  assert.equal(onlyName.model, 0);
  assert.ok(onlyName.name >= 8);
  assert.equal(onlyName.ctx, 5);
});

for (const width of [120, 100, 72, 48]) {
  test(`renderExplorer: width contract holds at ${width}`, () => {
    const lines = renderExplorer(stateFixture({ width }));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(visibleWidth(line), width, `line width ${visibleWidth(line)} != ${width}`);
    }
  });
}

test("renderExplorer: address bar shows pi / project / session + mod age", () => {
  const lines = renderExplorer(stateFixture());
  const bar = lines[0].map((s) => s.text).join("");
  assert.ok(bar.includes("pi / --proj-- / alpha"), `bar: ${bar}`);
  assert.ok(bar.includes("mod 2m ago"), `bar: ${bar}`);
});

test("renderExplorer: teleport mode replaces the address bar with input", () => {
  const lines = renderExplorer(stateFixture({ teleport: "alp" }));
  const bar = lines[0].map((s) => s.text).join("");
  assert.ok(bar.includes("pi / alp"), `bar: ${bar}`);
});

test("renderExplorer: navigation pane marks selection, middle keeps cursor", () => {
  const lines = renderExplorer(stateFixture({ pane: "nav", selected: 1 }));
  const body = lines.slice(1, -1);
  const navCursor = body.some((l) => l[0]?.text === "> " && l[0]?.bg === true);
  assert.ok(navCursor, "nav selection shows highlighted cursor");
});

test("renderExplorer: details pane hidden at width 48 shows F3 hint in middle", () => {
  const lines = renderExplorer(stateFixture({ width: 48 }));
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("[details hidden: F3]"), text);
});

test("renderExplorer: colors unnamed sessions error", () => {
  const state = stateFixture({ rows: [sessionFixture("(unnamed)", { unnamed: true })] });
  const lines = renderExplorer(state);
  const body = lines.slice(1, -1);
  const redName = body.some((line) => line.some((seg) => seg.color === "error" && seg.text.includes("(unnamed)")));
  assert.ok(redName, "unnamed session name rendered with error color");
});

test("sortRows: stable, undefined keys sink to the bottom", () => {
  const mk = (name, over = {}) => sessionFixture(name, over);
  const rows = [
    mk("b", { contextPercent: 90 }),
    mk("a", { contextPercent: undefined }),
    mk("c", { contextPercent: 10 }),
    mk("d", { contextPercent: undefined }),
  ];
  const byName = sortRows(rows, { field: "name", dir: "asc" }).map((r) => r.name);
  assert.deepEqual(byName, ["a", "b", "c", "d"]);
  const byCtx = sortRows(rows, { field: "ctx", dir: "desc" }).map((r) => r.name);
  assert.deepEqual(byCtx, ["b", "c", "a", "d"], "missing ctx sinks last in both directions");
  const byCtxAsc = sortRows(rows, { field: "ctx", dir: "asc" }).map((r) => r.name);
  assert.deepEqual(byCtxAsc, ["c", "b", "a", "d"]);
  // stability: same key keeps original order
  const stable = sortRows([mk("x"), mk("y"), mk("x")], { field: "name", dir: "asc" }).map((r) => r.key);
  assert.deepEqual(stable, ["x", "x", "y"]);
});

test("V003: sortRows sorts within the data region only; structural rows keep fixed order", () => {
  const mk = (name, over = {}) => sessionFixture(name, over);
  // a future spine region pinned root-first must survive any sort press
  const spineRoot = { ...mk("spine-root"), kind: "session", region: "spine" };
  const spineLeaf = { ...mk("spine-leaf"), kind: "session", region: "spine" };
  const rows = [mk("delta"), spineRoot, mk("alpha"), spineLeaf, mk("charlie")];
  const out = sortRows(rows, { field: "name", dir: "asc" });
  assert.equal(out[1].key, spineRoot.key, "spine root stays at its slot");
  assert.equal(out[3].key, spineLeaf.key, "spine leaf stays at its slot (root-first order kept)");
  const dataNames = [out[0].name, out[2].name, out[4].name];
  assert.deepEqual(dataNames, ["alpha", "charlie", "delta"], "data region sorted among itself");
  const desc = sortRows(rows, { field: "name", dir: "desc" });
  assert.equal(desc[1].key, spineRoot.key);
  assert.equal(desc[3].key, spineLeaf.key);
});

test("V003: orphan region stays below the data region after any sort", () => {
  const mk = (name, over = {}) => sessionFixture(name, over);
  const orphanA = { ...mk("orphan-a"), kind: "orphan", region: "orphan" };
  const orphanB = { ...mk("orphan-b"), kind: "orphan", region: "orphan" };
  const rows = [orphanA, mk("delta"), orphanB, mk("alpha")];
  const out = sortRows(rows, { field: "name", dir: "asc" });
  assert.deepEqual(out.map((r) => r.kind), ["orphan", "session", "orphan", "session"]);
  assert.deepEqual(out.filter((r) => r.kind !== "orphan").map((r) => r.name), ["alpha", "delta"]);
});

test("V003: buildLensRows tags the orphan block with the orphan region tag", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const mk = (node) => ({ key: node.path, kind: "session", depth: 0, name: node.id, path: node.path });
  const all = [...buildRecentRows(projects), ...a.children.map(mk)];
  const rows = buildLensRows(all, { focus: a.path, focusDepth: 2 });
  const orphans = rows.filter((r) => r.kind === "orphan");
  assert.ok(orphans.length > 0, "fixture produces orphans");
  assert.ok(orphans.every((r) => r.region === "orphan"), "every orphan row carries the orphan region tag");
  assert.ok(rows.filter((r) => r.kind !== "orphan").every((r) => (r.region ?? "data") === "data"), "descendants stay in the data region");
});

test("sortRows: unnamed sessions sink on a name sort in both directions", () => {
  const mk = (name, over = {}) => sessionFixture(name, over);
  const rows = [mk("(unnamed)", { unnamed: true }), mk("zebra"), mk("(unnamed)", { unnamed: true }), mk("apple")];
  const asc = sortRows(rows, { field: "name", dir: "asc" }).map((r) => r.name);
  assert.deepEqual(asc, ["apple", "zebra", "(unnamed)", "(unnamed)"]);
  const desc = sortRows(rows, { field: "name", dir: "desc" }).map((r) => r.name);
  assert.deepEqual(desc, ["zebra", "apple", "(unnamed)", "(unnamed)"]);
});

test("renderExplorer: middle-pane columns align with the header", () => {
  const state = stateFixture({ rows: [sessionFixture("alpha", { model: "kimi-k2" })] });
  const lines = renderExplorer(state);
  const text = (l) => l.map((s) => s.text).join("");
  const header = text(lines[1]);
  const rowLine = text(lines[2]);
  assert.equal(header.indexOf("MODEL"), rowLine.indexOf("kimi-k2"), "MODEL column aligns");
  // CTX% is right-aligned: the value sits inside the header's column slot
  const ctxSlot = header.indexOf("CTX%");
  const ctxValue = rowLine.indexOf("61%");
  assert.ok(ctxValue >= ctxSlot && ctxValue <= ctxSlot + 4, `CTX% value inside its slot (value ${ctxValue}, slot ${ctxSlot})`);
});

test("renderExplorer: high context renders with warning color", () => {
  const state = stateFixture({ rows: [sessionFixture("hot", { contextPercent: 91 })] });
  const lines = renderExplorer(state);
  const body = lines.slice(1, -1);
  const hot = body.some((line) => line.some((seg) => seg.color === "warning" && seg.text.includes("91%")));
  assert.ok(hot, "ctx >= 80% rendered in warning color");
});

test("renderExplorer: details handoff renders with warning color", () => {
  const state = stateFixture({ detail: sessionFixture("alpha", { handoff: "ho/x.md" }) });
  const lines = renderExplorer(state);
  const handoffSeg = lines.flat().find((s) => s.text.includes("ho/x.md"));
  assert.equal(handoffSeg.color, "warning");
});

test("renderExplorer: selected row never sinks under the floor", () => {
  // 30 rows, height 24 -> bodyHeight 22; header eats one line
  const rows = Array.from({ length: 30 }, (_, i) => sessionFixture(`sess-${String(i).padStart(2, "0")}`));
  for (const selected of [0, 15, 29]) {
    const lines = renderExplorer(stateFixture({ rows, selected, detail: rows[selected] }));
    const body = lines.slice(1, -1).map((l) => l.map((s) => s.text).join(""));
    const cursorLine = body.find((l) => l.includes(`> sess-${String(selected).padStart(2, "0")}`));
    assert.ok(cursorLine, `selected=${selected}: cursor rendered`);
    assert.ok(cursorLine.includes(`sess-${String(selected).padStart(2, "0")}`), `selected=${selected}: cursor on screen`);
  }
});

test("renderExplorer: help block anchors to the details pane corner", () => {
  const lines = renderExplorer(stateFixture());
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("KEYS"), "help block shown by default");
  assert.ok(text.includes("teleport"), "help lists teleport");
  const hidden = renderExplorer(stateFixture({ showHelp: false }));
  assert.ok(!hidden.map((l) => l.map((s) => s.text).join("")).join("\n").includes("KEYS"), "? hides the block");
});

test("renderExplorer: sort arrow marks the active column header", () => {
  const text = (lines) => lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  const asc = renderExplorer(stateFixture({ sort: { field: "name", dir: "asc" } }));
  assert.ok(text(asc).includes("NAME ^"), "name asc arrow");
  const byMtime = renderExplorer(stateFixture({ sort: { field: "mtime", dir: "desc" } }));
  assert.ok(text(byMtime).includes("MOD v"), "mtime desc arrow on MOD column");
  const byCtx = renderExplorer(stateFixture({ sort: { field: "ctx", dir: "asc" } }));
  assert.ok(text(byCtx).includes("CTX% ^"), "ctx asc arrow fits its widened column");
});

test("renderExplorer: status bar shows one-shot action message", () => {
  const lines = renderExplorer(stateFixture({ message: "copied: alpha" }));
  const status = lines[lines.length - 1].map((s) => s.text).join("");
  assert.ok(status.includes("2 sessions · copied: alpha"), status);
});

test("renderExplorer: status bar shows only the session count", () => {
  const lines = renderExplorer(stateFixture());
  const status = lines[lines.length - 1].map((s) => s.text).join("");
  assert.ok(status.trim().startsWith("2 sessions"), status);
  assert.ok(!status.includes("teleport"), "no key hints duplicated from the KEYS block");
});

// --- Feature A: expansion lens (V001/V002/V004/V006/V007) ---

test("descendantsOf: pure path-nesting cut within the depth budget", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const b = a.children.find((c) => c.id === "b");
  const runChild = a.children.find((c) => c.id === "run-x-child");
  const mk = (node) => ({ key: node.path, kind: "session", depth: 0, name: node.id, path: node.path });
  const all = [...buildRecentRows(projects), ...a.children.map(mk)];
  // b nests one step under a's stem; the run-layout child nests three
  assert.deepEqual(descendantsOf(all, a.path, 1).map((r) => r.path), [b.path]);
  assert.deepEqual(
    descendantsOf(all, a.path, 2).map((r) => r.path),
    [b.path],
    "depth 2 keeps the same cut — depth counts ancestry steps, not row count",
  );
  assert.deepEqual(
    descendantsOf(all, a.path, 3).map((r) => r.path).sort(),
    [b.path, runChild.path].sort(),
    "depth 3 reaches the run-layout child",
  );
  // purity: input rows untouched, no invented members
  assert.equal(all.length, 4, "input rows unchanged");
  assert.ok(descendantsOf(all, a.path, 3).every((r) => all.includes(r)), "descendants are a subset of the input");
  assert.deepEqual(descendantsOf(all, a.path, 0), []);
  assert.deepEqual(descendantsOf(all, null, 2), []);
  assert.deepEqual(
    descendantsOf(all, a.path, LENS_MAX_DEPTH + 5).map((r) => r.path).sort(),
    [b.path, runChild.path].sort(),
    "depth is guard-capped, not exceeded",
  );
  // non-descendants never join: c lives in a sibling folder branch
  const c = buildRecentRows(projects).find((r) => r.id === "c");
  assert.ok(!descendantsOf(all, a.path, LENS_MAX_DEPTH).includes(c), "sibling folder session is not a descendant");
});

test("buildLensRows: descendants block on top, orphan block with ? badge below", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const mk = (node) => ({ key: node.path, kind: "session", depth: 0, name: node.id, path: node.path });
  const all = [...buildRecentRows(projects), ...a.children.map(mk)];
  const rows = buildLensRows(all, { focus: a.path, focusDepth: 2 });
  const kinds = rows.map((r) => r.kind);
  const firstOrphan = kinds.indexOf("orphan");
  assert.ok(firstOrphan > 0, "orphans render below the descendants block");
  assert.ok(kinds.slice(0, firstOrphan).every((k) => k !== "orphan"), "no orphan interleaves");
  assert.ok(rows.slice(firstOrphan).every((r) => r.kind === "orphan"), "orphan block is contiguous");
  assert.ok(!rows.some((r) => r.path === a.path), "the focus row itself is not duplicated");
  assert.deepEqual(buildLensRows(buildRecentRows(projects), { focus: null, focusDepth: 0 }), buildRecentRows(projects), "no lens = passthrough");
});

test("buildLensRows: focus row excluded from orphans, nothing invented", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const all = buildRecentRows(projects);
  const rows = buildLensRows(all, { focus: a.path, focusDepth: 1 });
  assert.ok(!rows.some((r) => r.path === a.path), "focus never appears as its own orphan");
  for (const r of rows) assert.ok(all.some((o) => o.path === r.path), `orphan ${r.path} comes from the input`);
});

test("renderExplorer: orphan ? badge and ··· gap rows hold the width contract", () => {
  const orphan = { ...sessionFixture("zeta"), kind: "orphan" };
  const gap = { key: "gap", kind: "gap", depth: 0, name: "··· gap", path: "" };
  for (const width of [120, 100, 72, 48]) {
    const lines = renderExplorer(stateFixture({ width, rows: [orphan, gap], detail: orphan }));
    for (const line of lines) {
      assert.equal(visibleWidth(line), width, `line width at ${width}`);
    }
    const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
    assert.ok(text.includes("?"), `orphan badge visible at ${width}`);
    assert.ok(text.includes("··· gap"), `gap row visible at ${width}`);
  }
});

test("renderExplorer: orphan ? badge stays inside the middle pane at all contract widths", () => {
  for (const width of [120, 100, 72, 48]) {
    const lines = renderExplorer(stateFixture({ width, rows: [{ ...sessionFixture("zeta"), kind: "orphan" }] }));
    const body = lines.slice(1, -1);
    const orphanLine = body.map((l) => l.map((s) => s.text).join("")).find((t) => t.includes("zeta"));
    assert.ok(orphanLine, `orphan row rendered at ${width}`);
    assert.ok(orphanLine.includes("?"), `badge present at ${width}`);
  }
});

test("renderExplorer: existing kinds render unchanged when orphans/gaps are absent", () => {
  const before = renderExplorer(stateFixture());
  const text = before.map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.ok(!text.includes("··· gap"), "no gap row without a gap kind");
  assert.ok(!/\?/.test(text.replace(/\? help/, "")), "no orphan badge without orphan rows");
});

test("buildAddressBarPath: lens depth renders the @n suffix", () => {
  const bar = buildAddressBarPath(["proj"], { name: "sess", mtime: NOW - 2 * 60000 }, NOW, 3);
  assert.equal(bar.left, "pi / proj / sess @3");
  const zero = buildAddressBarPath(["proj"], { name: "sess" }, NOW, 0);
  assert.equal(zero.left, "pi / proj / sess", "depth 0 renders no suffix");
});

test("renderExplorer: address bar shows the @n lens suffix and the status bar keeps the full total", () => {
  const lines = renderExplorer(stateFixture({ focusDepth: 2, totalSessions: 7 }));
  const bar = lines[0].map((s) => s.text).join("");
  assert.ok(bar.includes("pi / --proj-- / alpha @2"), `bar: ${bar}`);
  const status = lines[lines.length - 1].map((s) => s.text).join("");
  assert.ok(status.trim().startsWith("7 sessions"), `status: ${status}`);
});

test("renderExplorer: help block lists the F4 tree toggle and the TAB lens hint", () => {
  const lines = renderExplorer(stateFixture());
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.ok(text.includes("F4 tree"), text);
  assert.ok(text.includes("tab lens"), text);
  assert.ok(!text.includes("tab tree"), "old TAB binding hint is gone");
});

// --- Feature C: search filter + ancestor stitching (V009) ---

test("buildSearchRows: filters survivors by name/project prefix, case-insensitive", () => {
  const rows = [sessionFixture("alpha"), sessionFixture("beta"), sessionFixture("alphabet")];
  const out = buildSearchRows(rows, "ALP", STORE, true);
  assert.deepEqual(out.map((r) => r.name), ["alpha", "alphabet"]);
  assert.ok(out.every((r) => r.kind === "session"), "survivors keep their actionable kind");
  assert.deepEqual(buildSearchRows(rows, "", STORE, true), rows, "empty query is a passthrough");
  assert.deepEqual(buildSearchRows(rows, "zzz", STORE, true), [], "no matches leaves zero rows (selection clamps)");
});

test("buildSearchRows: stitches the dim ancestor chain above each survivor, farthest first", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const b = a.children.find((c) => c.id === "b");
  const all = [
    ...buildRecentRows(projects),
    ...a.children.map((n) => ({ key: n.path, kind: "session", depth: 0, name: n.id, path: n.path, project: "p" })),
  ];
  const out = buildSearchRows(all, "b", STORE, true);
  const kinds = out.map((r) => r.kind);
  assert.deepEqual(kinds, ["ancestor", "session"], "one stem row directly above the survivor");
  assert.equal(out[0].path, a.path, "the stem row is a's own jsonl");
  assert.equal(out[0].region, "ancestry");
  assert.equal(out[1].path, b.path, "survivor keeps its place at the chain tail");
  assert.ok(all.every((r) => r.kind === "session"), "stitching is render-only: inputs untouched");
});

test("buildSearchRows: broken lineage renders gap rows, never a crash or invented parent", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const runChild = a.children.find((c) => c.id === "run-x-child");
  const all = [
    ...buildRecentRows(projects),
    ...a.children.map((n) => ({ key: n.path, kind: "session", depth: 0, name: n.id, path: n.path, project: "p" })),
  ];
  const out = buildSearchRows(all, "run-x", STORE, true);
  const kinds = out.map((r) => r.kind);
  // walk UP from run-0: run-0.jsonl missing (gap), run-x.jsonl missing (gap), a.jsonl exists (stem)
  assert.deepEqual(kinds, ["ancestor", "gap", "gap", "session"], `chain: ${JSON.stringify(kinds)}`);
  assert.equal(out[0].path, a.path, "farthest existing ancestor is the first header line");
  assert.ok(out.filter((r) => r.kind === "gap").every((r) => r.region === "ancestry"));
  assert.ok(out.every((r) => r.kind !== "ancestor" || !r.path.includes("run-x")), "no parent path invented for the missing stems");
});

test("buildSearchRows: shared ancestors render once — first header line per ancestor", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const b = a.children.find((c) => c.id === "b");
  const runChild = a.children.find((c) => c.id === "run-x-child");
  const mk = (n) => ({ key: n.path, kind: "session", depth: 0, name: n.id, path: n.path, project: "p" });
  const all = [...buildRecentRows(projects), ...a.children.map(mk)];
  const out = buildSearchRows(all, "run", STORE, true);
  const ancestors = out.filter((r) => r.kind === "ancestor");
  assert.equal(ancestors.length, 1, `a emitted once: ${JSON.stringify(out.map((r) => `${r.kind}:${r.name}`))}`);
  assert.equal(ancestors[0].path, a.path);
  assert.ok(out.some((r) => r.path === b.path || r.path === runChild.path), "survivors present");
});

test("buildSearchRows: a toggle OFF strips the chains, survivors only", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const mk = (n) => ({ key: n.path, kind: "session", depth: 0, name: n.id, path: n.path, project: "p" });
  const all = [...buildRecentRows(projects), ...a.children.map(mk)];
  const out = buildSearchRows(all, "b", STORE, false);
  assert.deepEqual(out.map((r) => r.kind), ["session"], "no ancestor/gap rows when the toggle is off");
});

test("V009: sort anchors each stitch block above its survivor via region pinning", () => {
  const projects = walkStore(STORE);
  const a = projects[0].sessions.find((s) => s.id === "a");
  const mk = (n) => ({ key: n.path, kind: "session", depth: 0, name: n.id, path: n.path, project: "p" });
  const all = [...buildRecentRows(projects), ...a.children.map(mk)];
  // rebuild order: sort FIRST, then stitch — a later sort press keeps every
  // ancestry/gap row at its slot (V003 regions) and re-anchoring re-stitches
  const stitched = buildSearchRows(all, "run", STORE, true);
  const sorted = sortRows(stitched, { field: "name", dir: "desc" });
  for (let i = 0; i < stitched.length; i++) {
    if ((stitched[i].region ?? "data") !== "data") {
      assert.equal(sorted[i].key, stitched[i].key, `structural row stays pinned at slot ${i} after a sort press`);
    }
  }
});

test("renderExplorer: ancestor rows are dim with a prefix and hold the width contract", () => {
  const ancestor = { key: "/p/a.jsonl", kind: "ancestor", depth: 0, name: "alpha", path: "/p/a.jsonl", region: "ancestry" };
  const survivor = sessionFixture("beta");
  for (const width of [120, 100, 72, 48]) {
    const lines = renderExplorer(stateFixture({ width, rows: [ancestor, survivor], detail: survivor }));
    for (const line of lines) assert.equal(visibleWidth(line), width, `line width at ${width}`);
    const body = lines.slice(1, -1).flat();
    const seg = body.find((s) => s.text.includes("↳"));
    assert.ok(seg, `ancestor row rendered at ${width}`);
    assert.equal(seg.color, "dim", "ancestor row is dim");
    assert.ok(seg.text.includes("alpha"), "ancestor name inside the NAME budget");
  }
});

test("buildAddressBarPath: ancestry toggle renders the badge", () => {
  const on = buildAddressBarPath(["proj"], undefined, NOW, 0, true);
  assert.equal(on.left, "pi / proj / ·a");
  const off = buildAddressBarPath(["proj"], undefined, NOW, 0, false);
  assert.equal(off.left, "pi / proj", "badge absent when the toggle is off");
});

test("renderExplorer: address bar shows the badge only when search stitching is active", () => {
  const lines = renderExplorer(stateFixture({ ancestry: true }));
  const bar = lines[0].map((s) => s.text).join("");
  assert.ok(bar.includes("·a"), `bar: ${bar}`);
  const off = renderExplorer(stateFixture({ ancestry: false }));
  assert.ok(!off[0].map((s) => s.text).join("").includes("·a"), "no badge when off");
});

// --- feature B (V005): failure-autopilot spine --------------------------------

test("buildSpineRows: root-first chain to the failed run, gaps kept, hidden count", () => {
  const recent = buildRecentRows(walkStore(STORE));
  const leaf = join(STORE, "--proj--", "a", "run-x", "run-0", "session.jsonl");
  const rows = buildSpineRows(recent, leaf, STORE);
  assert.deepEqual(rows.map((r) => r.kind), ["spine", "gap", "gap", "spine", "ellipsis"]);
  // root-first: the chain starts at the stem session a.jsonl
  assert.ok(rows[0].path.endsWith("a.jsonl"), `chain root: ${rows[0].path}`);
  assert.equal(rows[3].path, leaf, "the failed run ends the chain");
  assert.ok(rows.every((r) => r.region === "spine"), "every spine row is region-tagged");
  const shown = rows.filter((r) => r.kind !== "gap" && r.kind !== "ellipsis").length;
  const hidden = recent.length - shown;
  assert.equal(rows[4].name, `… (${hidden} hidden)`, "collapse row counts the hidden sessions");
});

test("buildSpineRows: chain members keep their status and error text", () => {
  const recent = buildRecentRows(walkStore(STORE));
  const failed = recent.find((r) => r.path.endsWith("a.jsonl"));
  const marked = { ...failed, status: "killed", errorText: "cut off" };
  const rest = recent.filter((r) => r !== failed);
  const rows = buildSpineRows([...rest, marked], marked.path, STORE);
  const head = rows.find((r) => r.path === marked.path);
  assert.equal(head.status, "killed", "status rides along");
  assert.equal(head.errorText, "cut off", "error text rides along");
});

test("V003: spine order stays root-first after any sort press", () => {
  const recent = buildRecentRows(walkStore(STORE));
  const leaf = join(STORE, "--proj--", "a", "run-x", "run-0", "session.jsonl");
  const spine = buildSpineRows(recent, leaf, STORE);
  const sorted = sortRows(spine, { field: "name", dir: "desc" });
  assert.deepEqual(sorted.map((r) => r.key), spine.map((r) => r.key), "sortRows cannot reorder the spine region");
});

test("renderExplorer: spine ✗ marker and … (n hidden) collapse hold the width contract", () => {
  const failed = { ...sessionFixture("root", { status: "killed", errorText: "boom" }), kind: "spine", region: "spine" };
  const collapse = { key: "e", kind: "ellipsis", depth: 0, name: "… (3 hidden)", path: "", region: "spine" };
  for (const width of [120, 100, 72, 48]) {
    const lines = renderExplorer(stateFixture({ width, rows: [failed, collapse], detail: failed }));
    for (const line of lines) assert.equal(visibleWidth(line), width, `line width at ${width}`);
    const body = lines.slice(1, -1).flat();
    const cross = body.find((s) => s.text.includes("✗"));
    assert.ok(cross, `✗ marker rendered at ${width}`);
    assert.equal(cross.color, "error", "✗ renders in the error color");
    const ell = body.find((s) => s.text.includes("… ("));
    assert.ok(ell, `collapse row rendered at ${width}`);
    assert.equal(ell.color, "dim", "collapse row is dim");
    if (width > 48) {
      // at 48 the details pane is hidden, so the details lines do not render
      assert.ok(body.some((s) => s.text.includes("boom")), `tail error text in the details pane at ${width}`);
      assert.ok(body.some((s) => s.text.includes("status: killed")), `status line in the details pane at ${width}`);
    }
  }
});

test("renderExplorer: ✗ marker never overflows the middle pane at any contract width", () => {
  const failed = { ...sessionFixture("a-very-long-session-name-that-fills-the-pane"), kind: "spine", region: "spine", status: "error" };
  for (const width of [120, 100, 72, 48]) {
    const lines = renderExplorer(stateFixture({ width, rows: [failed] }));
    assert.ok(
      lines.slice(1, -1).flat().some((s) => s.text.includes("✗")),
      `✗ present at ${width}`,
    );
    for (const line of lines) assert.equal(visibleWidth(line), width, `line width at ${width}`);
  }
});

// Headless unit tests for sprint B (tags.ts + aliases.ts). Run:
//   node --test test/tags.test.mjs
// Session names below are verbatim from the real store scan (2026-09-22).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAliases, saveAliases, ALIASES_FILE } from "../aliases.ts";
import {
  collectAliasGroups,
  parseProjectTag,
  projectKey,
  resolveProjectKey,
} from "../tags.ts";

// Real project dir names from ~/.pi/agent/sessions.
const MC = "--C--Users-HOME-Desktop-minecraft-typescript--";
const ORCH = "--C--Users-HOME-pi-orchestrator--";
const AE = "--C--Users-HOME-Desktop-Agentic-Engineering--";
const HOME = "--C--Users-HOME--";
const DIRS = [MC, ORCH, AE, HOME];

test("projectKey normalizes a store dir name", () => {
  assert.equal(projectKey(AE), "c-users-home-desktop-agentic-engineering");
});

test("resolveProjectKey matches exact and trailing kebab-slug", () => {
  assert.equal(resolveProjectKey("minecraft-typescript", DIRS), MC);
  assert.equal(resolveProjectKey("pi-orchestrator", DIRS), ORCH);
  assert.equal(resolveProjectKey("agentic-engineering", DIRS), AE);
  assert.equal(resolveProjectKey("nope", DIRS), undefined);
});

test("parseProjectTag: digit suffix tries the alphabetic prefix (planmd5 - setup)", () => {
  const tag = parseProjectTag("planmd5 - setup", ["--C--Users-HOME-.pi-agent-extensions-planmd--"]);
  assert.deepEqual(tag, { project: "--C--Users-HOME-.pi-agent-extensions-planmd--", matched: "planmd" });
});

test("parseProjectTag: bare trailing token without a matching project is undefined", () => {
  assert.equal(parseProjectTag("planmd8 final", DIRS), undefined);
});

test("parseProjectTag: alias beats heuristic and resolves the target dir (orch-debug-conductor)", () => {
  // "orch" is not a trailing slug of any dir — only the explicit alias resolves it
  const tag = parseProjectTag("orch-debug-conductor", DIRS, { orch: "pi-orchestrator" });
  assert.deepEqual(tag, { project: ORCH, matched: "orch" });
});

test("parseProjectTag: verb-led names carry no tag — the verb is the leading token", () => {
  // per ADR-0029 names are topic-only; "fix" in fix-ss-render-stuck-arrow is a verb
  assert.equal(parseProjectTag("fix-ss-render-stuck-arrow", DIRS, { ss: "minecraft-typescript" }), undefined);
});

test("parseProjectTag: two-letter slugs stay alias-only", () => {
  // no alias — "mc" is too short for the auto heuristic
  assert.equal(parseProjectTag("mc-fix-spawn-bug", DIRS), undefined);
  // with an alias it resolves
  assert.equal(parseProjectTag("mc-fix-spawn-bug", DIRS, { mc: "minecraft-typescript" })?.project, MC);
  // real store name: "pi" is also two letters — alias-only
  assert.equal(parseProjectTag("pi ext: workflow-orchestrator", DIRS), undefined);
  assert.equal(
    parseProjectTag("pi ext: workflow-orchestrator", DIRS, { pi: "pi-orchestrator" })?.project,
    ORCH,
  );
});

test("parseProjectTag: unnamed, empty, and short names are undefined", () => {
  assert.equal(parseProjectTag(undefined, DIRS), undefined);
  assert.equal(parseProjectTag("", DIRS), undefined);
  assert.equal(parseProjectTag("x", DIRS), undefined); // 10 real sessions are named "x"
  assert.equal(parseProjectTag("main6", DIRS), undefined);
});

test("parseProjectTag: case-insensitive leading token (Sakana road - github portfolio)", () => {
  const dirs = ["--C--Users-HOME-Desktop-Notes-Sakana-ai_road--"];
  const tag = parseProjectTag("Sakana road - github portfolio", dirs, { sakana: "sakana-ai-road" });
  assert.equal(tag?.project, dirs[0]);
});

test("parseProjectTag: a dangling alias resolves to nothing, not a guess", () => {
  assert.equal(parseProjectTag("ghost-topic-x", DIRS, { ghost: "no-such-project" }), undefined);
});

test("parseProjectTag: tag naming its own project is a no-op signal", () => {
  const planmdDir = "--C--Users-HOME-.pi-agent-extensions-planmd--";
  const tag = parseProjectTag("planmd-fix-render", [planmdDir]);
  assert.equal(tag?.project, planmdDir);
});

function node(id, name, extra = {}) {
  return { path: `/p/${id}.jsonl`, id, name, children: [], ...extra };
}
function project(name, sessions, folders = []) {
  return { path: `/store/${name}`, name, sessions, folders };
}

test("collectAliasGroups: move semantics — tagged session leaves its path project", () => {
  const planmdDir = "--C--Users-HOME-.pi-agent-extensions-planmd--";
  const projects = [
    project(HOME, [node("s1", "planmd5 - setup"), node("s2", "reassurance"), node("s3", undefined)]),
    project(planmdDir, []),
    project(MC, [node("m1", "mc-fix-spawn-bug")]),
  ];
  const { groups, rest } = collectAliasGroups(projects, { mc: "minecraft-typescript" });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "planmd");
  assert.equal(groups[0].project, planmdDir);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["s1"]);
  const home = rest.find((p) => p.name === HOME);
  assert.deepEqual(home.sessions.map((s) => s.id), ["s2", "s3"], "untagged and unnamed stay");
  const mc = rest.find((p) => p.name === MC);
  assert.deepEqual(mc.sessions.map((s) => s.id), ["m1"], "alias not in table: session stays");
  const planmd = rest.find((p) => p.name === planmdDir);
  assert.equal(planmd.sessions.length, 0, "moved session is not duplicated in the target");
  // pure: the original tree is untouched
  assert.equal(projects[0].sessions.length, 3);
});

test("collectAliasGroups: folders are swept too; children stay with the parent", () => {
  const planmdDir = "--C--Users-HOME-.pi-agent-extensions-planmd--";
  const folder = { path: "/f", name: "f", sessions: [node("f1", "planmd-cleanup")], folders: [] };
  const projects = [
    project(HOME, [node("p1", "planmd5 - setup", { children: [node("c1", "x")] })]),
    project(planmdDir, []),
    project(AE, []),
  ];
  projects[0].folders = [folder];
  const { groups, rest } = collectAliasGroups(projects, {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].project, planmdDir);
  assert.deepEqual(groups[0].sessions.map((s) => s.id).sort(), ["f1", "p1"]);
  const home = rest[0];
  assert.equal(home.sessions.length, 0);
  assert.equal(home.folders[0].sessions.length, 0);
  // the moved parent still carries its children for the tree view
  assert.equal(groups[0].sessions.find((s) => s.id === "p1").children.length, 1);
});

test("collectAliasGroups: no aliases and no resolvable tags → empty groups", () => {
  const projects = [project(HOME, [node("s1", "reassurance"), node("s2", "conductor debug cont")])];
  const { groups, rest } = collectAliasGroups(projects, {});
  assert.equal(groups.length, 0);
  assert.equal(rest[0].sessions.length, 2);
});

test("aliases load/save round-trip via tmp file; malformed file is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aliases-"));
  const file = join(dir, ALIASES_FILE);
  assert.deepEqual(await loadAliases(file), {}, "missing file");
  await saveAliases(file, { ss: "session-manager" });
  assert.deepEqual(await loadAliases(file), { ss: "session-manager" });
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.aliases.ss, "session-manager");
  await rm(dir, { recursive: true, force: true });
});

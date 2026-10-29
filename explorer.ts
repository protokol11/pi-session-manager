// Pure explorer view-model + three-pane Windows-Explorer renderer. No pi
// imports — unit-testable. The interactive `ctx.ui.custom` component lives in
// commands.ts; this module only turns state into colored screen lines.
//
// Layout (top → bottom):
//   row 0            Address Bar: "pi / project / session" ... "mod 2m ago"
//   rows 1..H-3      navigation pane | files-and-folders | details
//   row H-2          status bar
// Width contract: every line is exactly `width` visible columns. Usable pane
// width is `width - 4` when three panes are visible (4 separator columns) —
// see ADR-0030 and the address-bar prototype for the derivation.
import { basename, resolve } from "node:path";
import {
  descendantDepth,
  deriveAncestry,
  MAX_COMPANION_DEPTH,
  type FolderNode,
  type ProjectNode,
  type SessionNode,
} from "./walker.ts";
import type { AliasGroup } from "./tags.ts";
import type { RunStatus } from "./status.ts";

export type RowKind =
  | "project"
  | "folder"
  | "session"
  | "child"
  | "orphan"
  | "gap"
  | "ancestor"
  | "spine"
  | "ellipsis";
/** flat = project session list; tree = children inline (F4 toggles). */
export type ExplorerMode = "flat" | "tree";
export type Pane = "nav" | "middle";

/**
 * One lens state feeds one row builder (V002). `focus`/`focusDepth` are the
 * expansion lens (feature A); `pinned` is the optional flat/tree expansion
 * set that used to be the free-floating `expanded` Set<string>.
 */
export type LensState = {
  focus: string | null;
  focusDepth: number;
  pinned?: Set<string>;
  /** Live search filter (feature C, V009): the active `/` query, "" = none. */
  filter?: string;
};

/** focusDepth never exceeds the shared walker guard. */
export const LENS_MAX_DEPTH = MAX_COMPANION_DEPTH;

/** Region tag (V003): which lane of the middle pane a row belongs to.
 * `sortRows` reorders rows inside the `data` region only; every other
 * region renders in fixed builder order (spine root-first, ancestry above
 * its survivor, orphans below the data block). Builders default rows to
 * "data", so flat views keep their observable sort behavior. */
export type RowRegion = "data" | "orphan" | "spine" | "ancestry";

/** One selectable line in the files-and-folders pane. */
export type Row = {
  key: string;
  kind: RowKind;
  depth: number;
  name: string;
  path: string;
  /** Region lane; absent = "data" (see RowRegion). */
  region?: RowRegion;
  id?: string;
  cwd?: string;
  project?: string;
  model?: string;
  contextPercent?: number;
  handoff?: string;
  childCount?: number;
  hasChildren?: boolean;
  /** Child axis (ADR-0035 lineage): `⎇` subagent companion, `↦` transfer. */
  link?: "subagent" | "transfer";
  mtime?: number;
  unnamed?: boolean;
  /** Failure-autopilot classification (feature B, V005); absent = not classified. */
  status?: RunStatus;
  /** Tail error text for a failed run, shown in the details pane. */
  errorText?: string;
};

/** One entry in the navigation pane (a project or a virtual alias group). */
export type NavEntry = {
  name: string;
  path: string;
  sessionCount: number;
  selected?: boolean;
  /** Virtual group of tag-moved sessions (sprint B); rendered dim. */
  alias?: boolean;
};

export type LineColor = "default" | "error" | "accent" | "dim" | "muted" | "warning";
export type Segment = { text: string; color: LineColor; bg?: boolean };
export type Line = Segment[];

export type AddressBar = { left: string; right: string };

export type RenderState = {
  /** Navigation pane entries (projects + reserved placeholder rows). */
  nav: NavEntry[];
  /** Files-and-folders pane rows. */
  rows: Row[];
  /** Which pane owns keyboard focus. */
  pane: Pane;
  /** Selection index inside the focused pane. */
  selected: number;
  /** Session shown in the details pane (usually the focused middle row). */
  detail?: Row;
  /** Project name chain for the address bar (["rootProj"] or []). */
  addressPath: string[];
  mode: ExplorerMode;
  width: number;
  height: number;
  /** F3 toggle; when false the details pane collapses to a hint row. */
  showDetails?: boolean;
  /** Active teleport input text; null = breadcrumb mode. */
  teleport?: string | null;
  /** Confirm-delete hint flag. */
  confirmDelete?: boolean;
  /** Active sort, shown as a ^/v arrow on the sorted column header. */
  sort?: SortSpec;
  /** One-shot action feedback appended to the status bar. */
  message?: string | null;
  /** Lens focus depth for the address bar's ` @n` suffix (0/absent = none). */
  focusDepth?: number;
  /** Total session count for the status bar (lens view cuts rows; the total stays full). */
  totalSessions?: number;
  /** Show the key-help mini block in the corner of the details pane. */
  showHelp?: boolean;
  /** Show the `·a` ancestry badge (feature C toggle, default on). */
  ancestry?: boolean;
  /** Injectable clock for deterministic `mod … ago` rendering. */
  now?: number;
};

function sessionRow(node: SessionNode, depth: number, kind: RowKind, project: string, link?: Row["link"]): Row {
  return {
    key: node.path,
    kind,
    depth,
    name: node.name ?? "(unnamed)",
    path: node.path,
    id: node.id,
    project,
    childCount: node.children.length,
    hasChildren: node.children.length > 0,
    ...(link ? { link } : {}),
    unnamed: node.name === undefined,
    cwd: node.cwd,
    model: node.model,
    contextPercent: node.contextPercent,
    mtime: node.mtimeMs,
  };
}

/** Every top-level session across the given projects (folders recursed). */
function collectTreeSessions(projects: ProjectNode[]): SessionNode[] {
  const all: SessionNode[] = [];
  const gather = (sessions: SessionNode[], folders: FolderNode[]): void => {
    for (const s of sessions) all.push(s);
    for (const f of folders) gather(f.sessions, f.folders);
  };
  for (const p of projects) gather(p.sessions, p.folders);
  return all;
}

/**
 * Transfer lineage: map each session path to the sessions whose header
 * `parentSession` points at it (ADR-0035 rotation). Only pairs present in
 * the same walk are grouped; a dangling parent leaves the child at its
 * natural position (fail-open, nothing invented).
 */
export function transferChildrenOf(projects: ProjectNode[]): Map<string, SessionNode[]> {
  const all = collectTreeSessions(projects);
  const byPath = new Map(all.map((s) => [s.path, s]));
  const map = new Map<string, SessionNode[]>();
  for (const s of all) {
    const parent = s.parentSessionPath;
    if (!parent || parent === s.path || !byPath.has(parent)) continue;
    const list = map.get(parent);
    if (list) list.push(s);
    else map.set(parent, [s]);
  }
  return map;
}

/** Paths that own at least one transfer child in this walk. */
export function transferParentPaths(projects: ProjectNode[]): Set<string> {
  return new Set(transferChildrenOf(projects).keys());
}

type TreeCtx = {
  pinned: Set<string> | undefined;
  transfer: Map<string, SessionNode[]>;
  transferChildren: Set<string>;
  seen: Set<string>;
  rows: Row[];
};

function emitSession(
  node: SessionNode,
  depth: number,
  kind: RowKind,
  link: "subagent" | "transfer" | undefined,
  project: string,
  ctx: TreeCtx,
): void {
  if (ctx.seen.has(node.path)) return;
  ctx.seen.add(node.path);
  ctx.rows.push(sessionRow(node, depth, kind, project, link));
  if (!ctx.pinned?.has(node.path)) return;
  // subagent companions stay leaves (existing behavior); transfer children
  // recurse so a rotation chain A→B→C nests fully
  for (const child of node.children) {
    if (ctx.seen.has(child.path)) continue;
    ctx.seen.add(child.path);
    ctx.rows.push(sessionRow(child, depth + 1, "child", project, "subagent"));
  }
  for (const child of ctx.transfer.get(node.path) ?? []) {
    emitSession(child, depth + 1, "child", "transfer", project, ctx);
  }
}

/** A transfer child is hidden from its natural position only while its
 *  parent is expanded in the same build (it renders under the parent). */
function hiddenTransferChild(session: SessionNode, ctx: TreeCtx): boolean {
  return (
    session.parentSessionPath !== undefined &&
    ctx.transferChildren.has(session.path) &&
    ctx.pinned?.has(session.parentSessionPath) === true
  );
}

function emitFolder(folder: FolderNode, depth: number, project: string, ctx: TreeCtx): void {
  ctx.rows.push({ key: folder.path, kind: "folder", depth, name: folder.name, path: folder.path, project });
  for (const session of folder.sessions) {
    if (hiddenTransferChild(session, ctx)) continue;
    emitSession(session, depth + 1, "session", undefined, project, ctx);
  }
  for (const sub of folder.folders) {
    emitFolder(sub, depth + 1, project, ctx);
  }
}

/**
 * Tree view: folders (recursive) + sessions → (pinned) subagent children.
 * No project row — the middle pane shows the project already selected in
 * the navigation pane, so repeating its name here is noise (live-feedback
 * fix; a sorted column used to strand the redundant row at the list end).
 * One LensState feeds this builder: tree mode pins everything with children,
 * flat mode pins nothing unless the user pinned it (V002 — flat render is
 * byte-identical to the old `expanded`-set behavior).
 */
export function buildTreeRows(projects: ProjectNode[], lens: LensState): Row[] {
  const transfer = transferChildrenOf(projects);
  const transferChildren = new Set<string>();
  for (const list of transfer.values()) for (const s of list) transferChildren.add(s.path);
  const ctx: TreeCtx = { pinned: lens.pinned, transfer, transferChildren, seen: new Set(), rows: [] };
  for (const project of projects) {
    for (const folder of project.folders) {
      emitFolder(folder, 1, project.displayName, ctx);
    }
    for (const session of project.sessions) {
      if (hiddenTransferChild(session, ctx)) continue;
      emitSession(session, 1, "session", undefined, project.displayName, ctx);
    }
  }
  return ctx.rows;
}

/**
 * Pure lens cut (feature A): the descendant block — rows whose path nests
 * within `depth` levels under `focus` (guard-capped, shared with the
 * walker). Ancestry is path nesting only; nothing is invented.
 */
export function descendantsOf(rows: Row[], focus: string | null, depth: number): Row[] {
  if (!focus || depth <= 0) return [];
  const cap = Math.min(depth, LENS_MAX_DEPTH);
  return rows.filter((r) => {
    const d = descendantDepth(focus, r.path);
    return d > 0 && d <= cap;
  });
}

/**
 * Lens render (V007): descendants block on top, then an orphan block of
 * every non-descendant session (focus excluded) below, each carrying kind
 * "orphan" which renders the `?` badge. With no active lens the input rows
 * pass through unchanged (flat/tree renders keep current output).
 */
export function buildLensRows(rows: Row[], lens: LensState): Row[] {
  if (!lens.focus || lens.focusDepth <= 0) return rows;
  const desc = descendantsOf(rows, lens.focus, lens.focusDepth);
  const orphans = rows
    .filter((r) => r.path !== lens.focus && !desc.includes(r))
    .map((r) => ({ ...r, kind: "orphan" as RowKind, region: "orphan" as RowRegion }));
  return [...desc, ...orphans];
}

/**
 * Failure-autopilot spine (feature B, V005): the chain from the store-root
 * ancestor down to the deepest failed run, root-first, with every other
 * session collapsed into one `… (n hidden)` ellipsis row. Chain members
 * come from `all` when present (so they keep name/model/mtime/status);
 * a missing ancestor stem renders a `··· gap` row (V006 rules, nothing
 * invented). Every row is tagged region "spine" so region-pinned sort
 * (V003) keeps root-first order under any sort press.
 */
export function buildSpineRows(all: Row[], focusPath: string, storeRoot: string): Row[] {
  const byPath = new Map(all.map((r) => [r.path, r]));
  const chain: Row[] = [];
  const pushStem = (path: string): void => {
    const src = byPath.get(path);
    chain.push(
      src
        ? { ...src, kind: "spine" as RowKind, region: "spine" as RowRegion }
        : {
            key: path,
            kind: "spine" as RowKind,
            depth: 0,
            name: basename(path, ".jsonl"),
            path,
            region: "spine" as RowRegion,
          },
    );
  };
  // deriveAncestry walks nearest-first; reverse for root-first order
  for (const step of [...deriveAncestry(focusPath, storeRoot)].reverse()) {
    if (step.kind === "gap") {
      chain.push({
        key: `spine-gap:${chain.length}`,
        kind: "gap" as RowKind,
        depth: 0,
        name: "··· gap",
        path: "",
        region: "spine" as RowRegion,
      });
    } else {
      pushStem(step.path);
    }
  }
  pushStem(focusPath);
  const shown = chain.filter((r) => r.kind !== "gap").length;
  const hidden = Math.max(0, all.length - shown);
  return [
    ...chain,
    {
      key: "spine-ellipsis",
      kind: "ellipsis" as RowKind,
      depth: 0,
      name: `… (${hidden} hidden)`,
      path: "",
      region: "spine" as RowRegion,
    },
  ];
}

function countFolderSessions(folder: FolderNode): number {
  return folder.sessions.length + folder.folders.reduce((n, f) => n + countFolderSessions(f), 0);
}

/**
 * Navigation pane entries: Quick access first, then one per (post-move)
 * project, then one virtual entry per alias group holding tag-moved
 * sessions. The alias path is namespaced (`__alias__:<project>`) so it never
 * collides with a real store path; virtual entries render dim via the `__`
 * prefix.
 */
export function buildNavEntries(projects: ProjectNode[], aliasGroups: AliasGroup[] = []): NavEntry[] {
  const entries: NavEntry[] = [{ name: "Quick access", path: "__quick_access__", sessionCount: 0 }];
  for (const p of projects) {
    entries.push({
      name: p.displayName,
      path: p.path,
      sessionCount: p.sessions.length + p.folders.reduce((n, f) => n + countFolderSessions(f), 0),
    });
  }
  for (const g of aliasGroups) {
    entries.push({
      name: g.name,
      path: `__alias__:${g.project}`,
      sessionCount: g.sessions.length,
      alias: true,
    });
  }
  return entries;
}

/**
 * Index into buildNavEntries' project section for the project whose
 * majority cwd matches `cwd` (case-insensitive, both sides resolved).
 * Returns -1 when no project claims the directory — the caller then stays
 * on Quick access (entry 0). Pure — the explorer-entry seam.
 */
export function findProjectIndexByCwd(projects: ProjectNode[], cwd: string): number {
  const norm = (p: string): string => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const here = norm(cwd);
  return projects.findIndex((p) => p.cwd !== undefined && norm(p.cwd) === here);
}

/** Flat session rows for an alias group (tag-moved sessions, no folders). */
export function buildSessionRows(sessions: SessionNode[], project: string): Row[] {
  return sessions.map((s) => sessionRow(s, 0, "session", project));
}

function collectFolderSessions(folder: FolderNode, project: string, rows: Row[]): void {
  for (const session of folder.sessions) {
    rows.push(sessionRow(session, 0, "session", project));
  }
  for (const sub of folder.folders) {
    collectFolderSessions(sub, project, rows);
  }
}

/** Recent view: every top-level session across projects and folders, flat. */
export function buildRecentRows(projects: ProjectNode[]): Row[] {
  const rows: Row[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      rows.push(sessionRow(session, 0, "session", project.displayName));
    }
    for (const folder of project.folders) {
      collectFolderSessions(folder, project.displayName, rows);
    }
  }
  return rows;
}

/**
 * Search filter + ancestor stitching (feature C, V009). Survivors are the
 * rows whose name or project starts with the query (case-insensitive, same
 * matching rule as teleport resolve). With `showAncestors` on, each survivor
 * gets its stem-chain ancestry walked UP via the walker: every ancestor
 * renders once (kind "ancestor", dim `↳` row, region "ancestry") directly
 * above the survivor that first needed it; a broken/missing link renders a
 * `··· gap` row instead of crashing or inventing a parent. Stitching is
 * render-only — survivors keep kind "session"/"child" and stay the only
 * actionable rows. Callers sort survivors FIRST, then stitch, so each sort
 * anchors its stitch block above the sorted survivor.
 */
export function buildSearchRows(base: Row[], query: string, storeRoot: string, showAncestors: boolean): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return base;
  const survivors = base.filter(
    (r) => r.name.toLowerCase().startsWith(q) || (r.project ?? "").toLowerCase().startsWith(q),
  );
  if (!showAncestors) return survivors;
  const byPath = new Map(base.map((r) => [r.path, r]));
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const s of survivors) {
    if (s.kind !== "session" && s.kind !== "child") {
      out.push(s);
      continue;
    }
    const chain: Row[] = [];
    for (const step of [...deriveAncestry(s.path, storeRoot)].reverse()) {
      if (step.kind === "gap") {
        // a broken lineage link is a positional marker, rendered per chain
        chain.push({ key: `gap:${s.path}:${chain.length}`, kind: "gap", depth: 0, name: "··· gap", path: "", region: "ancestry" });
      } else if (!seen.has(step.path)) {
        // first header line per ancestor: shared stems render once
        seen.add(step.path);
        const src = byPath.get(step.path);
        chain.push({
          key: step.path,
          depth: 0,
          name: src?.name ?? basename(step.path, ".jsonl"),
          path: step.path,
          id: src?.id,
          project: src?.project ?? s.project,
          kind: "ancestor",
          region: "ancestry",
        });
      }
    }
    out.push(...chain, s);
  }
  return out;
}

/** Stable recent-first sort by mtime (missing mtime sorts last). */
export function sortByMtime(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
}

export type SortField = "name" | "mtime" | "ctx" | "model";
export type SortDir = "asc" | "desc";
export type SortSpec = { field: SortField; dir: SortDir };

function sortKey(row: Row, field: SortField): string | number | undefined {
  switch (field) {
    case "name":
      // unnamed sessions sink on a name sort regardless of direction —
      // 30 red "(unnamed)" rows must not bury the named ones
      return row.unnamed ? undefined : row.name.toLowerCase();
    case "mtime":
      return row.mtime;
    case "ctx":
      return row.contextPercent;
    case "model":
      return row.model?.toLowerCase();
  }
}

/**
 * Stable sort of the middle list, pinned to the `data` region (V003):
 * rows in any other region keep their exact slots and relative order —
 * the spine stays root-first, ancestry chains stay above their survivor,
 * and the orphan block stays below the data region. Only data-region
 * positions are refilled with the sorted rows. Rows with an undefined key
 * always sink to the bottom of the data region regardless of direction
 * (missing metadata is not "smallest").
 */
export function sortRows(rows: Row[], spec: SortSpec): Row[] {
  const sign = spec.dir === "asc" ? 1 : -1;
  const cmp = (a: Row, b: Row): number => {
    const ka = sortKey(a, spec.field);
    const kb = sortKey(b, spec.field);
    if (ka === undefined && kb === undefined) return 0;
    if (ka === undefined) return 1;
    if (kb === undefined) return -1;
    if (ka < kb) return -sign;
    if (ka > kb) return sign;
    return 0;
  };
  const dataIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i].region ?? "data") === "data") dataIdx.push(i);
  }
  const sorted = dataIdx.map((i) => rows[i]).sort(cmp);
  const out = rows.slice();
  dataIdx.forEach((slot, i) => {
    out[slot] = sorted[i];
  });
  return out;
}

/** Truncate/pad a segment list to exactly `width` visible columns. */
export function fit(segs: Segment[], width: number): Segment[] {
  const w = Math.max(1, width);
  const out: Segment[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= w) break;
    const remaining = w - used;
    if (s.text.length <= remaining) {
      out.push(s);
      used += s.text.length;
    } else {
      out.push({ ...s, text: s.text.slice(0, Math.max(0, remaining - 1)) + "…" });
      used = w;
      break;
    }
  }
  if (used < w) out.push({ text: " ".repeat(w - used), color: "default" });
  return out;
}

/** Human age: "2m", "3h", "2d". */
export function modAge(mtime: number, now: number): string {
  const m = Math.max(1, Math.round((now - mtime) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Serializable Address Bar path (ADR-0030): one string pair per focus state.
 * `path` is the project chain from the store root; `sessionName`/`mtime` are
 * shown when a session is focused.
 */
export function buildAddressBarPath(
  path: string[],
  session?: { name?: string; id?: string; mtime?: number },
  now?: number,
  focusDepth = 0,
  ancestry = false,
  mode?: ExplorerMode,
): AddressBar {
  const parts = ["pi", ...path];
  if (ancestry) parts.push("·a");
  if (session) {
    // an unnamed session is unidentifiable in the bar — pin the id tail to it;
    // the lens depth rides on the session segment: `sess @n` (feature A)
    const name = session.name ?? `(unnamed)·${session.id ? session.id.slice(-6) : "?"}`;
    parts.push(focusDepth > 0 ? `${name} @${Math.min(focusDepth, LENS_MAX_DEPTH)}` : name);
  } else if (focusDepth > 0) {
    parts.push(`@${Math.min(focusDepth, LENS_MAX_DEPTH)}`);
  }
  const left = parts.join(" / ");
  const right = session?.mtime !== undefined && now !== undefined ? `mod ${modAge(session.mtime, now)} ago` : "";
  // the flat/tree mode is always visible, independent of focus (amendment 2026-10-06)
  return { left: mode ? `${left}  [${mode}]` : left, right };
}

type PaneWidths = { wLeft: number; wMid: number; wRight: number };

/**
 * Deterministic pane survival (ADR-0030): usable width is `width - 4` with
 * three panes, `width - 3` when the details pane is hidden. Right pane dies
 * first, then the left shrinks; the middle pane never drops below 24.
 */
export function paneWidths(width: number, showDetails: boolean): PaneWidths {
  let inner = width - (showDetails ? 4 : 3);
  let wLeft = Math.max(18, Math.floor(inner * 0.26));
  let wRight = showDetails ? Math.max(24, Math.floor(inner * 0.3)) : 0;
  if (wLeft + wRight + 24 > inner) {
    wRight = 0;
  }
  if (wLeft + 24 > inner) {
    wLeft = Math.max(0, inner - 24);
  }
  const wMid = inner - wLeft - wRight + (wRight ? 0 : 1);
  return { wLeft, wMid, wRight };
}

type MidColumns = { name: number; model: number; ctx: number; mod: number };

/**
 * Deterministic column survival: NAME never collapses; MOD dies first, then
 * MODEL; CTX% survives (health signal). Column widths are fixed; NAME gets
 * the remainder. Middle pane floor is 24, so NAME keeps >= 8 always.
 * The sorted column gets one extra cell for the ^/v arrow.
 */
export function midColumns(wMid: number, active?: SortField): MidColumns {
  const CTX = active === "ctx" ? 7 : 5; // " CTX% v"
  const gaps = (n: number) => n - 1; // one space between columns
  const NAME_MIN = 8;
  let model = 10;
  let mod = active === "mtime" ? 6 : 4;
  let count = 4;
  let name = wMid - 2 - model - mod - CTX - gaps(count);
  if (name < NAME_MIN && mod > 0) {
    mod = 0;
    count = 3;
    name = wMid - 2 - model - CTX - gaps(count);
  }
  if (name < NAME_MIN && model > 0) {
    model = 0;
    count = 2;
    name = wMid - 2 - CTX - gaps(count);
  }
  return { name: Math.max(1, name), model, ctx: CTX, mod };
}

/** One row of the navigation pane. */
function renderNavRow(entry: NavEntry, selected: boolean, width: number): Segment[] {
  const placeholder = entry.path.startsWith("__");
  const cursor = selected ? "> " : "  ";
  const count = entry.sessionCount > 0 ? ` (${entry.sessionCount})` : "";
  return fit(
    [
      { text: cursor, color: "accent", bg: selected },
      { text: entry.name + count, color: placeholder ? "dim" : "accent", bg: selected },
    ],
    width,
  );
}

function midHeaderCell(label: string, width: number, active: boolean, dir: SortDir): string {
  const text = active ? `${label} ${dir === "asc" ? "^" : "v"}` : label;
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function renderMidHeader(cols: MidColumns, sort: SortSpec | undefined, selected: boolean, width: number): Segment[] {
  const segs: Segment[] = [{ text: "  ", color: "default", bg: selected }];
  segs.push({
    text: midHeaderCell("NAME", cols.name, sort?.field === "name", sort?.dir ?? "asc"),
    color: sort?.field === "name" ? "warning" : "accent",
    bg: selected,
  });
  if (cols.model) {
    segs.push({
      text: " " + midHeaderCell("MODEL", cols.model - 1, sort?.field === "model", sort?.dir ?? "asc"),
      color: sort?.field === "model" ? "warning" : "accent",
      bg: selected,
    });
  }
  segs.push({
    text: " " + midHeaderCell("CTX%", cols.ctx - 1, sort?.field === "ctx", sort?.dir ?? "asc"),
    color: sort?.field === "ctx" ? "warning" : "accent",
    bg: selected,
  });
  if (cols.mod) {
    segs.push({
      text: " " + midHeaderCell("MOD", cols.mod - 1, sort?.field === "mtime", sort?.dir ?? "asc"),
      color: sort?.field === "mtime" ? "warning" : "accent",
      bg: selected,
    });
  }
  return fit(segs, width);
}

/** One row of the files-and-folders pane. Column values align with the header. */
function renderMidRow(row: Row, selected: boolean, width: number, cols: MidColumns, now?: number): Segment[] {
  const cursor = selected ? "> " : "  ";
  const bg = selected;
  const segs: Segment[] = [{ text: cursor, color: "accent", bg }];
  if (row.kind === "ancestor") {
    // ancestor chain row (V009): a dim `↳` prefix inside the NAME budget;
    // the remaining columns stay blank so the line holds the width contract
    const prefix = "↳ ";
    const budget = Math.max(1, cols.name - prefix.length);
    const text = row.name.length >= budget ? row.name.slice(0, budget) : row.name.padEnd(budget);
    segs.push({ text: prefix + text, color: "dim", bg });
    if (cols.model) segs.push({ text: " ".repeat(cols.model), color: "default", bg });
    segs.push({ text: " ".repeat(cols.ctx), color: "default", bg });
    if (cols.mod) segs.push({ text: " ".repeat(cols.mod), color: "default", bg });
    return fit(segs, width);
  }
  if (row.kind === "gap" || row.kind === "ellipsis") {
    // broken lineage marker (V006) + spine collapse row (V005): a dim label
    // inside the NAME budget; the remaining columns stay blank so the line
    // still fits the contract
    const label = row.kind === "gap" ? "··· gap" : row.name;
    segs.push({ text: label.length <= cols.name ? label.padEnd(cols.name) : label, color: "dim", bg });
    if (cols.model) segs.push({ text: " ".repeat(cols.model), color: "default", bg });
    segs.push({ text: " ".repeat(cols.ctx), color: "default", bg });
    if (cols.mod) segs.push({ text: " ".repeat(cols.mod), color: "default", bg });
    return fit(segs, width);
  }
  // orphan badge (V004/V007) + spine failure marker (V005): `?` and `✗` are
  // budgeted INSIDE the NAME cell so they can never overflow the middle
  // pane; existing kinds keep byte-identical names
  const failed = row.status === "error" || row.status === "killed";
  const badge = row.kind === "orphan" ? 2 : row.kind === "spine" && failed ? 2 : 0;
  const badgeText = row.kind === "orphan" ? " ?" : " ✗";
  // child markers budgeted INSIDE the NAME cell: `↦` transfer lineage
  // (ADR-0035) vs `⎇` subagent companion — two axes, one tree
  const marker = row.kind === "child" ? (row.link === "transfer" ? "↦ " : "⎇ ") : "";
  const budget = Math.max(1, cols.name - badge - marker.length);
  const nameText = row.name.length >= budget ? row.name.slice(0, budget) : row.name.padEnd(budget);
  if (marker) segs.push({ text: marker, color: "dim", bg });
  segs.push({ text: nameText, color: row.unnamed ? "error" : "default", bg });
  if (badge) segs.push({ text: badgeText, color: row.kind === "spine" ? "error" : "warning", bg });
  if (cols.model) {
    // provider prefix burns the column on ids like "deepseek/deepseek-v4-pro";
    // the segment after the last slash is the part a human scans for
    const full = row.model ?? "—";
    const model = full.slice(full.lastIndexOf("/") + 1).slice(0, cols.model);
    segs.push({ text: " " + model.padEnd(cols.model - 1), color: "default", bg });
  }
  const ctx = row.contextPercent === undefined ? "?%" : `${row.contextPercent}%`;
  const hot = row.contextPercent !== undefined && row.contextPercent >= 80;
  segs.push({ text: " " + ctx.padStart(cols.ctx - 1), color: hot ? "warning" : "default", bg });
  if (cols.mod) {
    const age = row.mtime !== undefined && now !== undefined ? modAge(row.mtime, now) : "—";
    segs.push({ text: " " + age.padEnd(cols.mod - 1), color: "default", bg });
  }
  if (row.hasChildren) {
    segs.push({ text: ` +${row.childCount ?? 0}`, color: "dim", bg });
  }
  return fit(segs, width);
}

/** Details pane block for the selected session. */
function renderDetailLines(row: Row | undefined, width: number): Segment[][] {
  const lines: Segment[][] = [];
  const add = (label: string, value: string | undefined, color: LineColor = "default") => {
    lines.push(fit([{ text: `  ${label}: ${value ?? "—"}`, color }], width));
  };
  const rule = () => lines.push(fit([{ text: "  " + "─".repeat(Math.max(0, width - 2)), color: "dim" }], width));

  if (!row) {
    lines.push(fit([{ text: "  no selection", color: "muted" }], width));
    return lines;
  }

  lines.push(fit([{ text: `  ${row.name}`, color: row.unnamed ? "error" : "accent" }], width));
  rule();
  add("id", row.id, "muted");
  add("project", row.project, "muted");
  add("cwd", row.cwd, "muted");
  add("model", row.model, "muted");
  add("context", row.contextPercent === undefined ? "?%" : `${row.contextPercent}%`, "muted");
  add("handoff", row.handoff, row.handoff ? "warning" : "muted");
  if (row.status) add("status", row.status, row.status === "ok" ? "muted" : "error");
  if (row.errorText) add("error", row.errorText, "error");
  add("path", row.path, "muted");
  if (row.hasChildren) add("subagents", String(row.childCount ?? 0), "muted");
  return lines;
}

function renderAddressBar(state: RenderState, width: number): Segment[] {
  const modeTag = `  [${state.mode}]`;
  if (state.teleport !== null && state.teleport !== undefined) {
    return fit(
      [{ text: ` pi / ${state.teleport}${modeTag}`, color: "accent" }],
      width,
    );
  }
  const { left, right } = buildAddressBarPath(
    state.addressPath,
    state.detail
      ? { name: state.detail.name, id: state.detail.id, mtime: state.detail.mtime }
      : undefined,
    state.now,
    state.focusDepth ?? 0,
    state.ancestry === true,
    state.mode,
  );
  const rightSeg = fit([{ text: right, color: "default" }], Math.min(Math.max(right.length, 1), width));
  const rightWidth = rightSeg.reduce((n, s) => n + s.text.length, 0);
  return [
    ...fit([{ text: " " + left, color: "accent" }], Math.max(1, width - rightWidth)),
    ...rightSeg,
  ];
}

function renderStatusBar(state: RenderState, width: number): Segment[] {
  // total (+ one-shot action feedback) — the focus path lives in the Address
  // Bar, key hints in the corner KEYS block; duplicates removed per feedback
  const total = state.totalSessions ?? state.rows.length;
  const extra = state.message ? ` · ${state.message}` : "";
  const text = state.confirmDelete ? ` ${total} sessions · press d again to trash · esc cancel` : ` ${total} sessions${extra}`;
  return fit([{ text, color: "default" }], width);
}

/** Key-help mini block, anchored to the bottom of the details pane. */
const HELP_LINES = [
  " KEYS",
  " up/down move  left/right pane",
  " enter switch / focus",
  " c copy  x cut  p paste",
  " P pin (quick access)",
  " / teleport    s/S sort",
  " a ancestors  ~/F4 tree",
  " ! failures    tab lens",
  " F3 details    shift+tab/esc out",
  " alt+down/up expand",
  " d trash       q quit",
  " ? help",
];

function renderHelpBlock(width: number): Segment[][] {
  return HELP_LINES.map((l) => fit([{ text: l, color: "dim" }], width));
}

/**
 * Render the full three-pane screen. Every line is exactly `width` visible
 * columns; total height is exactly `height` lines.
 */
export function renderExplorer(state: RenderState): Line[] {
  const W = Math.max(1, state.width);
  const H = Math.max(3, state.height);
  const showDetails = state.showDetails !== false;
  const { wLeft, wMid, wRight } = paneWidths(W, showDetails);
  const cols = midColumns(wMid, state.sort?.field);
  const bodyHeight = Math.max(0, H - 2);
  const now = state.now ?? Date.now();

  const out: Line[] = [];
  out.push(renderAddressBar(state, W));

  const hintShift = wRight === 0 ? 1 : 0;

  // scroll the focused pane so the cursor stays visible; the middle pane
  // loses `1 + hintShift` lines to the column header (and details hint),
  // so its visible window is smaller than the raw body height
  const focusedCount = state.pane === "nav" ? state.nav.length : state.rows.length;
  const visibleCount =
    state.pane === "nav" ? bodyHeight : Math.max(1, bodyHeight - 1 - hintShift);
  let start = 0;
  if (state.selected >= visibleCount) start = state.selected - visibleCount + 1;
  const maxStart = Math.max(0, focusedCount - visibleCount);
  if (start > maxStart) start = maxStart;

  const detail = wRight > 0 ? renderDetailLines(state.detail, wRight) : [];
  const detailsHiddenHint = "[details hidden: F3]";
  const help = wRight > 0 && state.showHelp !== false ? renderHelpBlock(wRight) : [];
  const helpStart = Math.max(detail.length, bodyHeight - help.length);

  for (let y = 0; y < bodyHeight; y++) {
    const ri = start + y;
    const navSegs =
      state.pane === "nav" && ri < state.nav.length
        ? renderNavRow(state.nav[ri], ri === state.selected, wLeft)
        : ri < state.nav.length
          ? renderNavRow(state.nav[ri], false, wLeft)
          : fit([{ text: "", color: "default" }], wLeft);

    let midSegs: Segment[];
    if (y === 0) {
      midSegs = renderMidHeader(cols, state.sort, false, wMid);
    } else if (hintShift && y === 1) {
      midSegs = fit([{ text: " " + detailsHiddenHint, color: "dim" }], wMid);
    } else {
      const mi = ri - 1 - hintShift;
      if (state.pane === "middle" && mi >= 0 && mi < state.rows.length) {
        midSegs = renderMidRow(state.rows[mi], mi === state.selected, wMid, cols, now);
      } else if (mi >= 0 && mi < state.rows.length) {
        midSegs = renderMidRow(state.rows[mi], false, wMid, cols, now);
      } else {
        midSegs = fit([{ text: "", color: "default" }], wMid);
      }
    }

    let rightSegs: Segment[];
    if (wRight > 0) {
      if (y >= helpStart && y - helpStart < help.length) {
        rightSegs = help[y - helpStart];
      } else {
        rightSegs = y < detail.length ? detail[y] : fit([{ text: "", color: "default" }], wRight);
      }
    } else {
      rightSegs = [];
    }

    const line: Line = [...navSegs, { text: "│", color: "dim" }, ...midSegs];
    if (wRight > 0) line.push({ text: "│", color: "dim" }, ...rightSegs);
    out.push(fit(line, W));
  }

  out.push(renderStatusBar(state, W));
  return out;
}

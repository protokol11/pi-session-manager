// /sessions — full-screen three-pane Windows-Explorer over the on-disk store.
// All layout lives in explorer.ts; this handler only maps keys to state.
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildNavEntries,
  buildLensRows,
  buildRecentRows,
  buildSearchRows,
  buildSessionRows,
  buildSpineRows,
  buildTreeRows,
  findProjectIndexByCwd,
  LENS_MAX_DEPTH,
  renderExplorer,
  sortRows,
  transferParentPaths,
  type ExplorerMode,
  type LensState,
  type NavEntry,
  type Pane,
  type Row,
  type Segment,
  type SortField,
  type SortSpec,
} from "./explorer.ts";
import { scanHandoffs } from "./legged.ts";
import { readSessionHeader } from "./metadata.ts";
import { META_FILE, loadMetaCache, saveMetaCache } from "./meta-cache.ts";
import {
  classifyFile,
  loadStatusIndex,
  lookupStatus,
  saveStatusIndex,
  STATUS_FILE,
  type StatusIndex,
  type TailStatus,
} from "./status.ts";
import { copySession, deleteToTrash, moveSession } from "./ops.ts";
import { loadPins, PINS_FILE, savePins, togglePin } from "./pins.ts";
import { collectAliasGroups, type AliasTable, type TagMembership } from "./tags.ts";
import { loadAliases, saveAliases, ALIASES_FILE } from "./aliases.ts";
import {
  browse,
  teleportBackspace,
  teleportCancel,
  teleportInput,
  teleportOpen,
  teleportResolve,
  type TeleportState,
} from "./teleport.ts";
import { deriveAncestry, walkStore, type FolderNode, type ProjectNode } from "./walker.ts";

function applyTheme(theme: Theme, seg: Segment): string {
  let s = seg.text;
  if (seg.color === "error") s = theme.fg("error", s);
  else if (seg.color === "accent") s = theme.fg("accent", s);
  else if (seg.color === "dim") s = theme.fg("dim", s);
  else if (seg.color === "muted") s = theme.fg("muted", s);
  else if (seg.color === "warning") s = theme.fg("warning", s);
  if (seg.bg) s = theme.bg("selectedBg", s);
  return s;
}

/** Map every session id → relative handoff path, scanning each session's real cwd once. */
async function collectHandoffs(projects: ProjectNode[]): Promise<Map<string, string>> {
  const cwds = new Set<string>();
  const addCwds = (sessions: { path: string; cwd?: string }[], folders: FolderNode[]): void => {
    for (const session of sessions) {
      // prefer the cwd read during the walk; re-read the header only when absent
      let cwd = session.cwd;
      if (cwd === undefined) {
        try {
          cwd = readSessionHeader(session.path).cwd;
        } catch {
          continue;
        }
      }
      cwds.add(cwd);
    }
    for (const folder of folders) addCwds(folder.sessions, folder.folders);
  };
  for (const project of projects) addCwds(project.sessions, project.folders);

  const map = new Map<string, string>();
  for (const cwd of cwds) {
    for (const [id, path] of await scanHandoffs(cwd)) {
      map.set(id, path);
    }
  }
  return map;
}

/** Explorer-style sort steps: s steps forward through field+direction pairs
 * (second press on the same column flips to v), S steps back. */
const SORT_STEPS: SortSpec[] = [
  { field: "name", dir: "asc" },
  { field: "name", dir: "desc" },
  { field: "model", dir: "asc" },
  { field: "model", dir: "desc" },
  { field: "ctx", dir: "asc" },
  { field: "ctx", dir: "desc" },
  { field: "mtime", dir: "asc" },
  { field: "mtime", dir: "desc" },
];

function stepSort(current: SortSpec, delta: 1 | -1): SortSpec {
  const i = SORT_STEPS.findIndex((s) => s.field === current.field && s.dir === current.dir);
  return SORT_STEPS[(i + delta + SORT_STEPS.length) % SORT_STEPS.length];
}

export function registerExplorer(pi: ExtensionAPI): void {
  pi.registerCommand("ss-explorer", {
    description: "Browse, switch, and organize sessions from the on-disk store",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const root = join(homedir(), ".pi", "agent", "sessions");

      let projects: ProjectNode[] = [];
      let handoffs = new Map<string, string>();
      // sprint B — cwd-vs-tag membership: `projects` stays the raw walker
      // tree (Quick access and file ops use it); `tagMembership` is the
      // nav-visible view where tag-moved sessions leave their path project.
      let tagMembership: TagMembership = { groups: [], rest: [] };

      // Tag aliases (sprint B) must load BEFORE the first refresh: refresh
      // computes tagMembership from aliases (TDZ regression — loading after
      // the first refresh killed the whole explorer on open).
      const aliasesFile = join(root, ALIASES_FILE);
      let aliases: AliasTable = await loadAliases(aliasesFile);
      try {
        statSync(aliasesFile);
      } catch {
        aliases = { orch: "pi-orchestrator", mc: "minecraft-typescript", ae: "agentic-engineering" };
        await saveAliases(aliasesFile, aliases);
      }

      // Metadata cache (slice 3): computed during the walk so each session
      // file is read at most once per open; persisted in the extension cache.
      const cacheDir = join(homedir(), ".pi", "agent", "cache", "session-manager");
      mkdirSync(cacheDir, { recursive: true });
      const metaFile = join(cacheDir, META_FILE);
      let metaCache = await loadMetaCache(metaFile);

      const refresh = async (): Promise<void> => {
        try {
          projects = walkStore(root, { cache: metaCache, contextWindow: 128_000 });
          handoffs = await collectHandoffs(projects);
          tagMembership = collectAliasGroups(projects, aliases);
          void saveMetaCache(metaFile, metaCache);
        } catch {
          // leave previous projects in place; caller already surfaced the first error
        }
      };
      try {
        await refresh();
      } catch (err) {
        ctx.ui.notify(`sessions: cannot read store: ${(err as Error).message}`, "error");
        return;
      }

      // feature B (V005): failure-autopilot status index. Classifications
      // cache in a JSON sidecar keyed by path + mtime + size; a miss costs
      // one bounded tail read (never a whole-file read) and rewrites the
      // sidecar via temp file + rename.
      const statusFile = join(cacheDir, STATUS_FILE);
      let statusIndex: StatusIndex = await loadStatusIndex(statusFile);
      const persistStatus = (): void => {
        void (async () => {
          try {
            await saveStatusIndex(statusFile, statusIndex);
          } catch (err) {
            ctx.ui.notify(`ss-explorer: status save failed: ${(err as Error).message}`, "error");
          }
        })();
      };
      /** Cached tail classification; classifies + caches on a miss. */
      const statusFor = (path: string, mtimeMs: number, size: number): TailStatus => {
        const cached = lookupStatus(statusIndex, path, mtimeMs, size);
        if (cached) return cached;
        const result = classifyFile(path);
        statusIndex = { ...statusIndex, [path]: { mtimeMs, size, ...result } };
        persistStatus();
        return result;
      };

      const enrich = (row: Row): Row => {
        if (row.kind === "session" || row.kind === "child") {
          // model/contextPercent/cwd arrive from the walker via sessionRow;
          // only the handoff lookup and the cheap size stat remain here
          row.handoff = handoffs.get(row.id ?? "");
          try {
            const st = statSync(row.path);
            row.mtime = st.mtimeMs;
            const status = statusFor(row.path, st.mtimeMs, st.size);
            row.status = status.status;
            row.errorText = status.error;
          } catch {
            // keep undefined mtime/status
          }
        }
        return row;
      };

      // --- interaction state (TELEPORT DFA lives in teleport.ts) ---
      // flat = project session list, tree = children inline (F4 toggles);
      // recent lives behind the Quick access navigation entry. The lens
      // (feature A) is one LensState: TAB focuses, ESC/shift+tab peel depth
      // back to zero; `pinned` is the old flat/tree `expanded` set (V002).
      let mode: ExplorerMode = "flat";
      let sort: SortSpec = { field: "name", dir: "asc" };
      let showHelp = true;
      let pane: Pane = "middle"; // keyboard focus starts in files-and-folders
      let navSelected = 0;
      let midSelected = 0;
      let lens: LensState = { focus: null, focusDepth: 0, pinned: new Set<string>() };
      const lensActive = (): boolean => lens.focus !== null && lens.focusDepth > 0;
      // feature C (V009): ancestor stitching above search survivors; default ON
      let showAncestors = true;
      // feature B (V005): `!` failure-autopilot. spineFocus pins the middle
      // pane to one root→deepest-failed-run spine; repeat `!` cycles the
      // death list in a fixed order (deepest first, then by path).
      let spineFocus: string | null = null;
      let deathCycle = -1;
      let showDetails = true;
      let teleport: TeleportState = browse();
      let pendingDelete: number | null = null;
      let nav: NavEntry[] = [];
      let rows: Row[] = [];
      let clipboard: { path: string; cut: boolean } | null = null;
      let message: string | null = null;
      const pinsFile = join(root, PINS_FILE);
      let pins: string[] = await loadPins(pinsFile);

      // nav layout: [Quick access, projects (post-move)…, alias groups…]
      const QUICK_ACCESS = (): number => 0;
      const isQuickAccess = (): boolean => navSelected === QUICK_ACCESS();

      const currentProject = (): ProjectNode | undefined =>
        navSelected >= 1 && navSelected <= tagMembership.rest.length
          ? tagMembership.rest[navSelected - 1]
          : undefined;

      /** Tree view expands every session that has children, at any depth. */
      const expandAll = (project: ProjectNode): Set<string> => {
        const set = new Set<string>();
        const add = (sessions: { path: string; children: unknown[] }[], folders: FolderNode[]): void => {
          for (const s of sessions) if (s.children.length > 0) set.add(s.path);
          for (const f of folders) add(f.sessions, f.folders);
        };
        add(project.sessions, project.folders);
        // transfer lineage (ADR-0035): a parent with a `parentSession` child
        // must expand too, so the ↦ child renders under it
        for (const path of transferParentPaths([project])) set.add(path);
        return set;
      };

      /** Peel one lens level back (ESC / shift+tab, V002); at zero the lens clears. */
      const lensOut = (): void => {
        if (!lensActive()) return;
        const depth = lens.focusDepth - 1;
        lens = { ...lens, focusDepth: depth, focus: depth > 0 ? lens.focus : null };
      };

      /** Structural rows reject every file action (V009). */
      const actionable = (row: Row | undefined): row is Row =>
        row !== undefined && (row.kind === "session" || row.kind === "child");
      const structural = (row: Row | undefined): boolean =>
        row !== undefined && (row.kind === "ancestor" || row.kind === "gap");

      /** Total sessions across the store — the status bar count never follows the lens cut. */
      const totalSessions = (): number => buildRecentRows(projects).length;

      const rebuildRows = (): void => {
        // the live `/` filter is part of LensState (V009): while the teleport
        // DFA holds text, the middle pane filters + stitches ancestors live
        const filter = teleport.active ? teleport.text.trim() : "";
        lens = { ...lens, filter };
        const { groups, rest } = tagMembership;
        nav = buildNavEntries(rest, groups);
        if (spineFocus) {
          // failure-autopilot spine (feature B): root→deepest-failed-run
          // chain, everything else collapsed into `… (n hidden)`. Every
          // spine row is region-tagged, so sortRows cannot reorder it (V003).
          const all = buildRecentRows(projects).map(enrich);
          rows = buildSpineRows(all, spineFocus, root);
          clampSelection();
          return;
        }
        if (isQuickAccess()) {
          // pinned sessions on top (pin order), then the rest by current sort.
          // Pins survive search + stitching: the pinned block stays on top
          // unfiltered while the data region filters below (V009).
          const all = buildRecentRows(projects).map(enrich);
          const pinned = pins.map((p) => all.find((r) => r.path === p)).filter((r): r is Row => r !== undefined);
          const unpinned = all.filter((r) => !pins.includes(r.path));
          const data = sortRows(unpinned, sort);
          rows = [...pinned, ...(filter ? buildSearchRows(data, filter, root, showAncestors) : data)];
          clampSelection();
          return;
        }
        const projectIndex = navSelected - 1;
        if (projectIndex >= rest.length) {
          // alias group: flat list of the tag-moved sessions
          const group = groups[projectIndex - rest.length];
          const data = group ? sortRows(buildSessionRows(group.sessions, group.name).map(enrich), sort) : [];
          rows = filter ? buildSearchRows(data, filter, root, showAncestors) : data;
          clampSelection();
          return;
        }
        if (lensActive()) {
          // lens cut (feature A): descendants data region + orphan region
          // below it; sortRows reorders the data region only, so the orphan
          // lane never interleaves (V003/V007). An active search filters the
          // cut and stitches ancestors above each surviving descendant.
          const data = sortRows(buildLensRows(buildRecentRows(projects).map(enrich), lens), sort);
          rows = filter ? buildSearchRows(data, filter, root, showAncestors) : data;
          clampSelection();
          return;
        }
        const project = currentProject();
        const base = project
          ? buildTreeRows([project], mode === "tree" ? { focus: null, focusDepth: 0, pinned: expandAll(project) } : lens)
          : [];
        const data = sortRows(base.map(enrich), sort);
        // sort FIRST, then stitch: every sort press re-anchors each stitch
        // block above its (re-sorted) survivor (V003 regions + V009)
        rows = filter ? buildSearchRows(data, filter, root, showAncestors) : data;
        clampSelection();
      };

      /** Sort defaults per location; applied when the cursor moves in the nav pane. */
      const sortForLocation = (): void => {
        sort = isQuickAccess() ? { field: "mtime", dir: "desc" } : { field: "name", dir: "asc" };
      };

      const addressPath = (): string[] => {
        if (isQuickAccess()) return ["Quick access"];
        const project = currentProject();
        if (project) return [project.displayName];
        const { groups, rest } = tagMembership;
        const group = groups[navSelected - 1 - rest.length];
        return group ? [group.name] : [];
      };

      const clampSelection = (): void => {
        const count = pane === "nav" ? nav.length : rows.length;
        const sel = () => (pane === "nav" ? navSelected : midSelected);
        const clamped = Math.max(0, Math.min(sel(), Math.max(0, count - 1)));
        if (pane === "nav") navSelected = clamped;
        else midSelected = clamped;
      };

      // Entry focus (spec sprint A): pick the project whose majority cwd is
      // the directory pi was launched from; when nothing matches, stay on
      // Quick access entry 0 — the recent view.
      {
        const match = findProjectIndexByCwd(tagMembership.rest, process.cwd());
        navSelected = match >= 0 ? match + 1 : 0;
      }
      sortForLocation();
      rebuildRows();
      clampSelection();

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        return {
          render(width: number): string[] {
            // The editor area sits above a fixed input dock + status bar (~5 lines).
            const height = Math.max(10, tui.terminal.rows - 5);
            const detailRow = rows[midSelected];
            return renderExplorer({
              nav,
              rows,
              pane,
              selected: pane === "nav" ? navSelected : midSelected,
              detail: detailRow && (detailRow.kind === "session" || detailRow.kind === "child" || detailRow.kind === "spine") ? detailRow : undefined,
              addressPath: addressPath(),
              mode,
              width,
              height,
              showDetails,
              showHelp,
              sort,
              message,
              teleport: teleport.active ? teleport.text : null,
              confirmDelete: pendingDelete !== null,
              focusDepth: lens.focusDepth,
              ancestry: showAncestors && teleport.active && teleport.text.trim() !== "",
              totalSessions: totalSessions(),
              now: Date.now(),
            }).map((line) => line.map((seg) => applyTheme(theme, seg)).join(""));
          },
          invalidate() {},
          handleInput(data: string) {
            // --- TELEPORT state consumes all keys first (DFA, see teleport.ts) ---
            if (teleport.active) {
              if (matchesKey(data, Key.escape)) {
                teleport = teleportCancel();
                // filter cleared: restore the unfiltered rows (V009)
                rebuildRows();
              } else if (matchesKey(data, Key.enter)) {
                const action = teleportResolve(teleport, rows);
                if (action.kind === "switch") {
                  done(action.path);
                  return;
                }
                if (action.kind === "focus-project") {
                  const idx = tagMembership.rest.findIndex((p) => p.displayName === action.name);
                  if (idx >= 0) {
                    navSelected = idx;
                    midSelected = 0;
                    rebuildRows();
                  }
                }
                teleport = teleportCancel();
              } else if (matchesKey(data, Key.backspace)) {
                teleport = teleportBackspace(teleport);
                // live filter: every edit re-filters + re-stitches (V009)
                rebuildRows();
              } else {
                teleport = teleportInput(teleport, data);
                rebuildRows();
              }
              tui.requestRender();
              return;
            }

            /** Flat/tree mode toggle: `~` (primary) and F4 (alias). */
            const toggleMode = (): void => {
              pendingDelete = null;
              mode = mode === "flat" ? "tree" : "flat";
              midSelected = 0;
              rebuildRows();
              clampSelection();
              tui.requestRender();
            };

            // --- Key dispatch table (V008): one owner per binding ---
            // Each entry owns its key(s) exclusively; the first match wins and
            // no key maps to two handlers. Owners are documented per binding so
            // future keys (`a`, `!`, mode toggle) slot into one place each.
            type KeyBinding = {
              id: string;
              owner: string;
              match: (data: string) => boolean;
              run: (data: string) => void;
            };
            const keyDispatch: KeyBinding[] = [
              {
                id: "up/down",
                owner: "navigation",
                match: (d) => matchesKey(d, Key.up) || matchesKey(d, Key.down),
                run: (d) => {
                  pendingDelete = null;
                  const delta = matchesKey(d, Key.up) ? -1 : 1;
                  if (pane === "nav") {
                    navSelected = Math.max(0, Math.min(nav.length - 1, navSelected + delta));
                    // live-follow: the middle pane shows the entry under the cursor
                    // (projects, alias groups, and Quick access rebuild the rows)
                    sortForLocation();
                    midSelected = 0;
                    rebuildRows();
                  } else {
                    midSelected = Math.max(0, Math.min(rows.length - 1, midSelected + delta));
                  }
                  tui.requestRender();
                },
              },
              {
                id: "left/right",
                owner: "navigation",
                match: (d) => matchesKey(d, Key.left) || matchesKey(d, Key.right),
                run: (d) => {
                  pendingDelete = null;
                  pane = matchesKey(d, Key.left) ? "nav" : "middle";
                  clampSelection();
                  tui.requestRender();
                },
              },
              {
                id: "/",
                owner: "teleport (feature C: search)",
                match: (d) => d === "/",
                run: () => {
                  pendingDelete = null;
                  teleport = teleportOpen();
                  tui.requestRender();
                },
              },
              {
                id: "F3",
                owner: "view",
                match: (d) => matchesKey(d, Key.f3),
                run: () => {
                  showDetails = !showDetails;
                  tui.requestRender();
                },
              },
              {
                id: "s",
                owner: "sort",
                match: (d) => d === "s",
                run: () => {
                  pendingDelete = null;
                  sort = stepSort(sort, 1);
                  rebuildRows();
                  tui.requestRender();
                },
              },
              {
                id: "S",
                owner: "sort",
                match: (d) => d === "S",
                run: () => {
                  pendingDelete = null;
                  sort = stepSort(sort, -1);
                  rebuildRows();
                  tui.requestRender();
                },
              },
              {
                id: "c/x",
                owner: "clipboard",
                match: (d) => d === "c" || d === "x",
                run: (d) => {
                  const sel = rows[midSelected];
                  if (pane !== "middle" || !sel) return;
                  if (actionable(sel)) {
                    clipboard = { path: sel.path, cut: d === "x" };
                    message = `${d === "x" ? "cut" : "copied"}: ${sel.name}`;
                    tui.requestRender();
                  } else if (structural(sel)) {
                    // V009: ancestor/gap rows are render-only and must never
                    // feed the clipboard the wrong path
                    message = "ancestor rows are not actionable";
                    tui.requestRender();
                  }
                },
              },
              {
                id: "p",
                owner: "clipboard",
                match: (d) => d === "p",
                run: () => {
                  const sel = rows[midSelected];
                  if (!clipboard || structural(sel)) return;
                  // V009: paste targets a folder row or the path project only —
                  // ancestor/gap rows are never a paste target
                  const targetDir =
                    pane === "middle" && sel?.kind === "folder" ? sel.path : currentProject()?.path;
                  if (!targetDir) return;
                  const src = clipboard.path;
                  const wasCut = clipboard.cut;
                  message = null;
                  void (async () => {
                    try {
                      if (wasCut) await moveSession(src, targetDir);
                      else await copySession(src, targetDir);
                      message = `pasted into ${targetDir === currentProject()?.path ? (currentProject()?.displayName ?? "project") : "folder"}`;
                      clipboard = null;
                    } catch (err) {
                      ctx.ui.notify(`ss-explorer: paste failed: ${(err as Error).message}`, "error");
                    }
                    await refresh();
                    rebuildRows();
                    clampSelection();
                    tui.requestRender();
                  })();
                },
              },
              {
                id: "P",
                owner: "pins",
                match: (d) => d === "P",
                run: () => {
                  const sel = rows[midSelected];
                  if (pane !== "middle" || !sel) return;
                  if (actionable(sel)) {
                    pins = togglePin(pins, sel.path);
                    message = pins.includes(sel.path) ? `pinned: ${sel.name}` : `unpinned: ${sel.name}`;
                    rebuildRows();
                    tui.requestRender();
                    void (async () => {
                      try {
                        await savePins(pinsFile, pins);
                      } catch (err) {
                        ctx.ui.notify(`ss-explorer: pin save failed: ${(err as Error).message}`, "error");
                      }
                    })();
                  } else if (structural(sel)) {
                    message = "ancestor rows are not actionable";
                    tui.requestRender();
                  }
                },
              },
              {
                id: "?",
                owner: "view",
                match: (d) => d === "?",
                run: () => {
                  showHelp = !showHelp;
                  tui.requestRender();
                },
              },
              {
                id: "enter",
                owner: "actions",
                match: (d) => matchesKey(d, Key.enter),
                run: () => {
                  if (pane === "nav") {
                    pane = "middle";
                    midSelected = 0;
                    rebuildRows();
                    tui.requestRender();
                  } else {
                    const sel = rows[midSelected];
                    if (actionable(sel)) {
                      done(sel.path);
                    } else if (structural(sel)) {
                      message = "ancestor rows are not actionable";
                      tui.requestRender();
                    }
                  }
                },
              },
              {
                id: "F4",
                owner: "mode toggle alias (V001: moved off TAB; `~` is primary)",
                match: (d) => matchesKey(d, Key.f4),
                run: () => toggleMode(),
              },
              {
                id: "~",
                owner: "mode toggle (amendment 2026-10-06; F4 is the alias)",
                match: (d) => d === "~",
                run: () => toggleMode(),
              },
              {
                id: "shift+tab",
                owner: "lens (feature A)",
                match: (d) => matchesKey(d, Key.shift("tab")),
                run: () => {
                  pendingDelete = null;
                  if (!lensActive()) return;
                  lensOut();
                  rebuildRows();
                  clampSelection();
                  tui.requestRender();
                },
              },
              {
                id: "tab",
                owner: "lens focus (feature A, V001)",
                match: (d) => matchesKey(d, Key.tab),
                run: () => {
                  pendingDelete = null;
                  // TAB sets the lens on the focused session row and leaves
                  // `mode` untouched; depth starts at 1 and never exceeds
                  // the shared guard (V001/V002)
                  const sel = rows[midSelected];
                  if (pane === "middle" && sel && (sel.kind === "session" || sel.kind === "child")) {
                    lens = { ...lens, focus: sel.path, focusDepth: Math.min(1, LENS_MAX_DEPTH) };
                    midSelected = 0;
                    rebuildRows();
                    clampSelection();
                    tui.requestRender();
                  }
                },
              },
              {
                id: "alt+down",
                owner: "tree expansion",
                match: (d) => matchesKey(d, Key.alt("down")),
                run: () => {
                  pendingDelete = null;
                  const sel = rows[midSelected];
                  if (mode === "tree" && sel && sel.kind === "session" && sel.hasChildren) {
                    lens.pinned?.add(sel.path);
                    rebuildRows();
                    tui.requestRender();
                  }
                },
              },
              {
                id: "alt+up",
                owner: "tree expansion",
                match: (d) => matchesKey(d, Key.alt("up")),
                run: () => {
                  pendingDelete = null;
                  const sel = rows[midSelected];
                  if (mode === "tree" && sel && sel.kind === "session" && sel.hasChildren) {
                    lens.pinned?.delete(sel.path);
                    rebuildRows();
                    tui.requestRender();
                  }
                },
              },
              {
                id: "d/D",
                owner: "delete",
                match: (d) => d === "d" || d === "D",
                run: () => {
                  const sel = rows[midSelected];
                  if (pane !== "middle" || !sel) return;
                  if (structural(sel)) {
                    message = "ancestor rows are not actionable";
                    tui.requestRender();
                    return;
                  }
                  if (actionable(sel)) {
                    if (pendingDelete === midSelected) {
                      void (async () => {
                        try {
                          await deleteToTrash(root, sel.path);
                        } catch (err) {
                          ctx.ui.notify(`sessions: delete failed: ${(err as Error).message}`, "error");
                        }
                        pendingDelete = null;
                        await refresh();
                        rebuildRows();
                        clampSelection();
                        tui.requestRender();
                      })();
                    } else {
                      pendingDelete = midSelected;
                      tui.requestRender();
                    }
                  }
                },
              },
              {
                id: "!",
                owner: "failure autopilot (feature B, V005)",
                match: (d) => d === "!",
                run: () => {
                  pendingDelete = null;
                  // deterministic death list: deepest failure first (the
                  // spec's initial spine target), path order within a depth
                  const depthOf = (path: string): number => {
                    let n = 0;
                    for (const step of deriveAncestry(path, root)) if (step.kind === "stem") n++;
                    return n;
                  };
                  const deaths = buildRecentRows(projects)
                    .map(enrich)
                    .filter((r) => r.status === "error" || r.status === "killed")
                    .sort((a, b) => depthOf(b.path) - depthOf(a.path) || a.path.localeCompare(b.path));
                  // no deaths is a terminal no-op: nothing changes (V008)
                  if (deaths.length === 0) return;
                  deathCycle = (deathCycle + 1) % deaths.length;
                  spineFocus = deaths[deathCycle].path;
                  midSelected = 0;
                  rebuildRows();
                  clampSelection();
                  tui.requestRender();
                },
              },
              {
                id: "a",
                owner: "ancestry toggle (feature C, V009)",
                match: (d) => d === "a",
                run: () => {
                  // toggles the dim ↳ ancestor chains above search survivors;
                  // default ON, one toggle per press (V008 dispatch table)
                  showAncestors = !showAncestors;
                  pendingDelete = null;
                  rebuildRows();
                  tui.requestRender();
                },
              },
              {
                id: "escape",
                owner: "lens exit, then session exit",
                match: (d) => matchesKey(d, Key.escape),
                run: () => {
                  // an active spine exits first, then the lens peels one
                  // depth level off; the session exits only once both are
                  // gone (V002 + feature B)
                  if (spineFocus) {
                    pendingDelete = null;
                    spineFocus = null;
                    deathCycle = -1;
                    rebuildRows();
                    clampSelection();
                    tui.requestRender();
                    return;
                  }
                  if (lensActive()) {
                    pendingDelete = null;
                    lensOut();
                    rebuildRows();
                    clampSelection();
                    tui.requestRender();
                    return;
                  }
                  done(null);
                },
              },
              {
                id: "q/Q",
                owner: "session exit",
                match: (d) => d === "q" || d === "Q",
                run: () => done(null),
              },
            ];

            // Unhandled keys fall through silently (unchanged behavior).
            for (const binding of keyDispatch) {
              if (binding.match(data)) {
                binding.run(data);
                return;
              }
            }
          },
        };
      }, {});

      if (result) {
        const { cancelled } = await ctx.switchSession(result);
        if (cancelled) ctx.ui.notify("sessions: switch cancelled", "warning");
      }
    },
  });
}

// Sprint B — cwd-vs-tag membership. Pure project-tag parsing and alias
// grouping over the walker tree. No pi imports — unit-testable.
import type { FolderNode, ProjectNode, SessionNode } from "./walker.ts";
import { normalizeSlug } from "./normalize-slug.ts";

/** User-maintained short form → project key (trailing kebab-slug of a project dir). */
export type AliasTable = Record<string, string>;

export type TagMatch = { project: string; matched: string };

/** Normalized store key of a project dir name. */
export function projectKey(dirName: string): string {
  return normalizeSlug(dirName);
}

/**
 * Resolve a candidate key to a project dir name: exact match first, then the
 * candidate as the trailing kebab-slug of the dir name (…-<candidate>).
 * First hit in store order wins; callers pass a deterministic order.
 */
export function resolveProjectKey(candidate: string, projectDirNames: string[]): string | undefined {
  const cand = projectKey(candidate);
  if (!cand) return undefined;
  for (const dir of projectDirNames) {
    if (projectKey(dir) === cand) return dir;
  }
  for (const dir of projectDirNames) {
    const key = projectKey(dir);
    if (key.endsWith(`-${cand}`)) return dir;
  }
  return undefined;
}

/**
 * Parse the project tag an agent hid in a session name. Per ADR-0029 a name
 * carries topic only, but legacy and other agents still prefix one. Tag = the
 * leading token, cut at the first - : _ or whitespace run; a trailing digit
 * suffix also tries its alphabetic prefix ("planmd5" → "planmd"). Aliases
 * (explicit user intent) beat the auto trailing-slug heuristic; auto-match
 * needs a candidate of ≥3 chars so two-letter slugs stay alias-only. A
 * dangling alias (target project absent) resolves to nothing — no guessing.
 */
export function parseProjectTag(
  name: string | undefined,
  projectDirNames: string[],
  aliases: AliasTable = {},
): TagMatch | undefined {
  if (!name) return undefined;
  const token = name.match(/^[^\-:_\s]+/)?.[0];
  if (!token) return undefined;
  const norm = projectKey(token);
  if (!norm) return undefined;
  const candidates: string[] = [norm];
  const alpha = norm.match(/^(.*?)\d+$/)?.[1];
  if (alpha && alpha.length >= 2 && !candidates.includes(alpha)) candidates.push(alpha);

  for (const cand of candidates) {
    for (const [key, value] of Object.entries(aliases)) {
      if (projectKey(key) !== cand) continue;
      const project = resolveProjectKey(value, projectDirNames);
      return project ? { project, matched: key } : undefined;
    }
    if (cand.length >= 3) {
      const project = resolveProjectKey(cand, projectDirNames);
      if (project) return { project, matched: cand };
    }
  }
  return undefined;
}

/** Virtual nav group: sessions whose name-tag names another project. */
export type AliasGroup = {
  /** Display name — the matched key (alias or slug). */
  name: string;
  /** Target project dir name. */
  project: string;
  sessions: SessionNode[];
};

export type TagMembership = { groups: AliasGroup[]; rest: ProjectNode[] };

function splitTagged(
  sessions: SessionNode[],
  ownDir: string,
  dirNames: string[],
  aliases: AliasTable,
  moved: Map<string, { name: string; sessions: SessionNode[] }>,
): SessionNode[] {
  const kept: SessionNode[] = [];
  for (const session of sessions) {
    const tag = parseProjectTag(session.name, dirNames, aliases);
    if (tag && tag.project !== ownDir) {
      const group = moved.get(tag.project) ?? { name: tag.matched, sessions: [] };
      group.sessions.push(session);
      moved.set(tag.project, group);
    } else {
      kept.push(session);
    }
  }
  return kept;
}

function filterFolder(
  folder: FolderNode,
  ownDir: string,
  dirNames: string[],
  aliases: AliasTable,
  moved: Map<string, { name: string; sessions: SessionNode[] }>,
): FolderNode {
  return {
    ...folder,
    sessions: splitTagged(folder.sessions, ownDir, dirNames, aliases, moved),
    folders: folder.folders.map((f) => filterFolder(f, ownDir, dirNames, aliases, moved)),
  };
}

/**
 * Dual membership, move semantics (sprint B): a named session whose leading
 * token resolves to another project leaves its path project and appears only
 * in that project's alias group. A tag matching the session's own project is
 * a no-op; subagent children stay with their parent. Pure — builds new
 * project/folder arrays; session nodes are shared by reference.
 */
export function collectAliasGroups(projects: ProjectNode[], aliases: AliasTable): TagMembership {
  const dirNames = projects.map((p) => p.name);
  const moved = new Map<string, { name: string; sessions: SessionNode[] }>();
  const rest: ProjectNode[] = projects.map((p) => ({
    ...p,
    sessions: splitTagged(p.sessions, p.name, dirNames, aliases, moved),
    folders: p.folders.map((f) => filterFolder(f, p.name, dirNames, aliases, moved)),
  }));
  const groups: AliasGroup[] = [...moved.entries()]
    .map(([project, g]) => ({ project, name: g.name, sessions: g.sessions }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { groups, rest };
}

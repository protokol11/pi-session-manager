// Teleport input DFA (ADR-0030). Pure — no pi imports, unit-testable.
//
// States: BROWSE (inactive) / TELEPORT (active, text <= TELEPORT_MAX).
// Transitions:
//   open()                      BROWSE      -> TELEPORT("")
//   teleportInput(st, data)     TELEPORT    -> TELEPORT(text+data)  [printable, len cap]
//   teleportBackspace(st)       TELEPORT    -> TELEPORT(text-1)     ["" -> stays ""]
//   teleportCancel()            any         -> BROWSE
//   teleportResolve(st, rows)   TELEPORT    -> action; caller decides exit
// Terminal: resolve returns "switch" (done) or "focus-project"; caller leaves
// TELEPORT on any resolve, stays in TELEPORT when there is no match.
import type { Row } from "./explorer.ts";

export const TELEPORT_MAX = 128;

export type TeleportState = { active: boolean; text: string };

export function browse(): TeleportState {
  return { active: false, text: "" };
}

export function teleportOpen(): TeleportState {
  return { active: true, text: "" };
}

/** Append one printable character; ignores control sequences and the length cap. */
export function teleportInput(st: TeleportState, data: string): TeleportState {
  if (!st.active || data.length !== 1) return st;
  const code = data.charCodeAt(0);
  if (code < 32 || code === 127) return st;
  if (st.text.length >= TELEPORT_MAX) return st;
  return { active: true, text: st.text + data };
}

export function teleportBackspace(st: TeleportState): TeleportState {
  if (!st.active || st.text.length === 0) return st;
  return { active: true, text: st.text.slice(0, -1) };
}

export function teleportCancel(): TeleportState {
  return browse();
}

export type TeleportAction =
  | { kind: "none" }
  | { kind: "switch"; path: string }
  | { kind: "focus-project"; name: string }
  // `@n` suffix: set the expansion lens on the matched session at depth n.
  | { kind: "lens"; path: string; depth: number };

/** Case-insensitive prefix match on session name or project name. */
export function teleportMatches(rows: Row[], text: string): Row[] {
  const q = text.toLowerCase();
  return rows.filter(
    (r) => r.name.toLowerCase().startsWith(q) || (r.project ?? "").toLowerCase().startsWith(q),
  );
}

/**
 * Split a trailing `@n` depth suffix off the query text.
 * Returns the base query and the depth, or null when the suffix is absent.
 * A present-but-invalid suffix (`@0`, `@x`, `@-1`, `@`) resolves to none —
 * the caller must abstain, never guess a depth.
 */
export function splitDepthSuffix(text: string): { base: string; depth: number } | { base: string; depth: null } | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return { base: text, depth: null };
  const base = text.slice(0, at);
  const suffix = text.slice(at + 1);
  if (!/^\d+$/.test(suffix)) return null;
  const depth = Number(suffix);
  if (!Number.isSafeInteger(depth) || depth <= 0) return null;
  return { base, depth };
}

/**
 * Enter: first match wins — a session switches, a project moves focus.
 * A trailing `@n` turns a session match into a lens action at depth n.
 * An invalid `@n` suffix (`@0`, `@x`) abstains: none, nothing changes.
 * No match is a no-op (stays in TELEPORT, nothing changes).
 */
export function teleportResolve(st: TeleportState, rows: Row[]): TeleportAction {
  if (!st.active) return { kind: "none" };
  const split = splitDepthSuffix(st.text);
  if (split === null) return { kind: "none" };
  const matches = teleportMatches(rows, split.base);
  const first = matches[0];
  if (!first) return { kind: "none" };
  if (first.kind === "session" || first.kind === "child") {
    if (split.depth !== null) return { kind: "lens", path: first.path, depth: split.depth };
    return { kind: "switch", path: first.path };
  }
  return { kind: "focus-project", name: first.name };
}

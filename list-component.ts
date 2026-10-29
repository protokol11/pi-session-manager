// Pure headless render seam for the session list. No pi imports — unit-testable.

export type RenderedLine = { text: string; color: "error" | "default" };
export type ListItem = { name?: string; lastModel?: string; contextPercent?: number; legged?: string };

function padOrTruncate(text: string, width: number): string {
  if (text.length <= width) return text + " ".repeat(width - text.length);
  return text.slice(0, width - 1) + "…";
}

/** Render a flat list of sessions. Each line is exactly `visibleWidth` chars. */
export function renderList(items: ListItem[], opts: { visibleWidth: number }): RenderedLine[] {
  const width = Math.max(1, opts.visibleWidth);
  return items.map((item) => {
    const unnamed = !item.name;
    const pct = item.contextPercent === undefined ? "?%" : `${item.contextPercent}%`;
    let text = `${item.name ?? "(unnamed)"}  ${item.lastModel ?? "?"}  ${pct}`;
    if (item.legged) text += `  <legged> ${item.legged}`;
    return { text: padOrTruncate(text, width), color: unnamed ? "error" : "default" };
  });
}

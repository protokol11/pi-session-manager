// Pure session-name normalizer. No pi imports — unit-testable in isolation.

/**
 * Normalize an arbitrary string to a verb-led kebab-slug.
 * Lowercase, collapse whitespace/underscore runs to "-", turn any other
 * non-[a-z0-9-] run into a "-", collapse/trim hyphens, soft-cap 64 chars.
 */
export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

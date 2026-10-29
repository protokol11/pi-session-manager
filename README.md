# pi-session-manager

> pi extension that gives every agent session a verb-led kebab-slug name and a Windows-Explorer-style browser over the on-disk session store.
> Published as [`@protokol11/pi-session-manager`](https://www.npmjs.com/package/@protokol11/pi-session-manager) on npm; the source of truth lives in the [`agent-governance`](https://github.com/protokol11/agent-governance) monorepo (`lifecycle/session-manager`).

## Why

A session named `session-2026-01-14-a3f9` carries no information. A session named `fix-ss-render-stuck-arrow` is a machine-readable identity: a human can scan it, a script can grep it, and a handoff contract can reference it. The companion session-transfer system passes work between sessions by sessionId, and the slug is the display form of that id. This extension makes the identity stable and browsable.

Scope: naming the session, normalizing the slug, and exploring/organizing the store (copy, move, trash, pins, tag aliases, failure-status sidecars). Non-scope: creating sessions, changing session storage format, and performing the transfer itself.

## How it works

The agent calls the `name_session` tool once at the start of the first real task, and again after a handoff or compaction only if the topic shifted. The tool runs the raw string through `normalizeSlug` — lowercase, collapse whitespace/underscores to `-`, strip any character outside `[a-z0-9-]`, trim and collapse hyphens, soft-cap at 64 characters — and hands the result to `pi.setSessionName`. The project name never enters the slug; the project is derived from the working directory.

The explorer command `ss-explorer` walks `~/.pi/agent/sessions` into a project/folder tree and renders a three-pane layout: navigation, session list, details. A metadata cache (`~/.pi/agent/cache/session-manager/meta.json`) keeps each session file read at most once per open. A status sidecar classifies each session tail (finished, error, running) with one bounded tail read keyed by path + mtime + size. Pins, tag aliases, and sort state live in small JSON sidecars under the same cache directory.

```
name_session("Fix SS render stuck arrow")
        │
        ▼
normalizeSlug ──▶ "fix-ss-render-stuck-arrow"  ──▶ pi.setSessionName(slug)
                                                        │
                              session-transfer contract (sessionId)
                                                        │
ss-explorer ◀── walk ~/.pi/agent/sessions + sidecars (pins, aliases, status)
```

Sources: decisions D13–D17 in `.docs/PIPELINE.md`; journey files under `portfolio-facts&plans/journey/` (memory-governance and related).

## Quick start

```sh
npm install @protokol11/pi-session-manager
```

Or from a clone of this repo:

```sh
cp -r pi-session-manager ~/.pi/agent/extensions/pi-session-manager
```

Restart pi. The `name_session` tool registers on start; the explorer opens with `/ss-explorer`.

## Usage

Start a task and let the agent name the session:

```text
name_session: "fix-ss-render-stuck-arrow"
Session named: fix-ss-render-stuck-arrow
```

Then browse the store:

```text
/ss-explorer
```

The explorer opens flat mode sorted by name. Press `s`/`S` to step through sort fields (name, model, context percent, mtime), `F4` to toggle tree view, TAB to focus the lens and ESC to peel it back, and the keys shown in the built-in help overlay for copy, move, trash, and pin.

## Contributing

Issues and patches go to the [agent-governance](https://github.com/protokol11/agent-governance) monorepo under `lifecycle/session-manager` (this repo is a publish mirror). Tests are plain Node test-runner files under `test/` and run with:

```sh
node --test 'test/*.test.mjs'
```

Layout lives in `explorer.ts`, key handling in `commands.ts`, slug normalization in `normalize-slug.ts` (no pi imports, unit-testable in isolation).

## License

MIT — see [LICENSE](./LICENSE).

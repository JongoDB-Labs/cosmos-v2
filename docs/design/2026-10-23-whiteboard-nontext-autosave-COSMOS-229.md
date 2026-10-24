# COSMOS-229 — whiteboard does not persist non-text input: where the fix belongs

**Status:** investigated in core, **not fixable from this repository**. Hand to
whoever can push to the whiteboard plugin repo.
**Date:** 2026-10-23.

## The report

> whenever i draw on the whiteboard or move/resize elements in whiteboard, then
> refresh, the elements don't save state

Triaged BUG / high / effort M, with acceptance criteria about freehand drawings
and position/size changes surviving a refresh, and no regression for text.

## Why this ticket cannot be closed in `cosmos-v2`

**There is no whiteboard code in this repository, by design.** The whiteboard is
a private plugin (ADR 0004, "plugin delivery and IP separation"); core composes
it at build time from `plugins/whiteboard/overlay/**` via
`scripts/plugins/sync.mjs`, and every composed path is added to
`.git/info/exclude` so plugin code can never land in the public core. Verified in
this worktree:

- `git ls-files src/plugins` → nothing; `src/plugins/` does not exist.
- `src/lib/plugins/registry/index.ts` is the zero-plugin `export {}` stub.
- `grep -ril whiteboard src/` matches only `src/lib/security/headers.ts` (the CSP
  allowance for the realtime sidecar) and `src/lib/changelog.ts`.
- No `@excalidraw/*` dependency in `package.json`.

What core holds is the **pin**, in `plugins.lock.json`:

```json
"whiteboard": { "ref": "c9c5e1cbb8b28d75535247415e9ea1e7e162f2b7" }
```

The repo is `cosmos/plugins/whiteboard` on the private plugin GitLab (the host
is named in `plugins/<slug>/.git/config` on a composed checkout; it is
deliberately not written down here, since this repo is public). It is not
checked out on this machine and that host does not resolve from the build
sandbox, so the source could not be read, let alone changed. A core-side "fix" would have been a guess at code nobody
involved can see.

## The regression window is one plugin commit, and it is the obvious suspect

The whiteboard has been pinned exactly twice since it started shipping:

| core commit | date | whiteboard ref | what it carried |
|---|---|---|---|
| `cc83e72d` | 2026-08-11 | `edf66405` | first release that composes the whiteboard at all (2.276.7) |
| `f5137c06` | 2026-08-11 | `c9c5e1cb` | `cosmos/plugins/whiteboard!2` — the **autosave** change (2.276.8) |

`c9c5e1cb` has been the pin ever since; no whiteboard change has shipped in the
~10 weeks between it and this report. So any autosave regression introduced after
launch was introduced by `!2`, whose own changelog entry reads:

> A whiteboard left open on screen kept re-saving itself even when nobody was
> drawing… **Boards now save when something actually changes.**

That MR added a "did anything actually change?" gate in front of a debounced
autosave. This ticket says some kinds of change no longer reach the backend.
**Start there**, and read `!2`'s diff before anything else.

## Hypotheses, most likely first

All three predict "text survives, pointer gestures don't", which is the shape of
the report.

1. **The gate defers while a gesture is in flight and never re-fires.** If the
   save is skipped whenever Excalidraw's `appState` shows an in-progress
   element (`newElement` / `draggingElement` / `resizingElement` / the
   `editingElement` equivalents), the *last* `onChange` of a drag, a resize or a
   freehand stroke is the one that gets dropped, and no further `onChange`
   arrives to replace it once the pointer is up. Text is different: committing a
   text edit emits an `onChange` after the editing state has cleared, so it
   passes the gate. Fix shape: re-arm the debounce on `onPointerUp` /
   flush on gesture end, rather than dropping the event.
2. **The change signature ignores geometry.** If "actually changed" is computed
   from a projection of the elements (ids, types, text content, element count)
   rather than from `getSceneVersion(elements)` or each element's `version`, then
   moving or resizing changes nothing the signature can see, and re-drawing over
   an existing stroke mutates `points` in place without changing the count.
   `getSceneVersion` from `@excalidraw/excalidraw` is the supported answer and is
   monotonic per element mutation.
3. **Payload size.** A freehand scene is orders of magnitude larger than a text
   scene (`points` arrays). If the autosave writes through a Server Action rather
   than the route handler the design doc specifies, Next's default 1 MB body
   limit would reject exactly the big-scene case while small text edits keep
   working. Cheap to rule out: watch the network tab for a 413 / rejected action
   on a board with a few strokes on it.

Core's half of the write path was read and **ruled out**: `src/lib/storage/`
(`adapter-local`, `adapter-s3`) does a full-object `put` with no size cap, no
truncation and no content-dependent branching, so it cannot persist a text scene
while dropping a freehand one.

Note the failure mode is invisible in-session either way, because the scene stays
live in the Yjs room — which the design doc warns about explicitly: *"Never let
the sidecar hold the only copy. Its documents are ephemeral by design; a board
that exists only in a room dies when the room empties."* That is precisely what a
refresh exposes.

## How to confirm, in the plugin repo

1. Open a board, draw one stroke, wait past the debounce, and check the board's
   `updatedAt` / the object-storage `storageKey` object actually changed. Repeat
   for a drag and for a resize. Compare against a text edit, which is expected to
   work.
2. Revert `!2`'s gate locally. If drawings persist again, the gate is the cause
   and the fix is to make it recognise geometry changes — not to remove it, or
   the re-save loop it fixed comes straight back.
3. The regression test belongs with `!2`'s tests: feed the change-detector two
   scenes that differ only in `x`/`y`, only in `width`/`height`, and only in a
   stroke's `points`, and assert each is reported as changed. Keep the existing
   "identical scene ⇒ no save" assertion so neither bug can return alone.

## Core-side follow-up: the fix is not shipped until core re-pins

**A plugin change ships nothing on its own.** Once the fix lands in the plugin,
core must re-pin `plugins.lock.json` to the new plugin commit or the assembly
composes the old one and the board behaves exactly as it does today. That pin IS
a shippable path under the version gate, so the re-pin commit also needs
`npm run release:bump <next-patch>` and a matching `src/lib/changelog.ts` entry
in the same commit — the shape `f5137c06` used when it pinned `c9c5e1cb`.

Beyond that, nothing in core needs to change for this bug, and nothing was
changed. The one
core-side observation worth recording: feedback triage routes every report to
`cosmos-v2`, including reports about surfaces that only exist in a plugin. A
ticket for plugin-owned code cannot be delivered by an agent working in a core
worktree, because the code is not there and the remote is unreachable. If that
recurs, the triage step — not the implementation step — is the place to fix it.

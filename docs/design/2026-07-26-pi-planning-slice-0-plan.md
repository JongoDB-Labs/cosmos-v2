# PI Planning — Slice 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the plugin SDK able to compose an npm dependency, restore the isolation guard for hyphenated slugs, make `sync.mjs` worktree-safe — then scaffold `cosmos-plugin-pi-planning` and prove it composes.

**Architecture:** Three small changes to core plugin tooling, then a no-op plugin repo that composes cleanly. Nothing about PI planning itself is built here. The point is to prove the seam works before pouring a multi-week feature through it.

**Tech Stack:** Node ESM scripts (`scripts/plugins/*.mjs`), vitest, Prisma 7, Next 16 (Cache Components on).

**Design doc:** `docs/design/2026-07-26-pi-planning-plugin-design.md`

---

## Why dependency composition is not just "merge package.json"

`Dockerfile:5-6` copies `package.json` **and** `package-lock.json`, then runs `npm ci`.
`npm ci` fails hard when the two disagree. So merging a dependency into
`package.json` without regenerating the lock produces a composed image that cannot
build. The composer must do both. `package-lock.json` is a tracked core file, so it
gets the same `skip-worktree` + `git checkout` treatment `sync.mjs` already applies
to `schema.prisma` and the two registry files.

---

## Task 1: `pluginModelPrefix` — slug → Prisma model prefix

The isolation guard at `plugin-isolation.arch.test.ts:116` builds
`new RegExp("\\bprisma\\." + slug + "[A-Z]")`. For slug `pi-planning` that is
`prisma.pi-planning[A-Z]`, which can never match the real accessor
`prisma.piPlanningCard` — so the "shared code never queries plugin-owned models"
guard silently passes for any hyphenated slug. It works today only because
every slug in use today is a single word.

**Files:**
- Create: `src/lib/plugins/slug.ts`
- Create: `src/lib/plugins/__tests__/slug.test.ts`
- Modify: `src/lib/plugins/__tests__/plugin-isolation.arch.test.ts:111-126`

**Step 1: Write the failing test**

```ts
// src/lib/plugins/__tests__/slug.test.ts
import { describe, it, expect } from "vitest";
import { pluginModelPrefix } from "../slug";

describe("pluginModelPrefix", () => {
  it("passes a single-word slug through unchanged", () => {
    expect(pluginModelPrefix("foreman")).toBe("foreman");
  });

  it("camelCases a hyphenated slug to match the Prisma client accessor", () => {
    // Prisma exposes `model PiPlanningCard` as `prisma.piPlanningCard`.
    expect(pluginModelPrefix("pi-planning")).toBe("piPlanning");
  });

  it("handles multiple hyphens", () => {
    expect(pluginModelPrefix("a-b-c")).toBe("aBC");
  });

  it("handles a digit after a hyphen (no uppercase form)", () => {
    expect(pluginModelPrefix("v2-sync")).toBe("v2Sync");
  });
});
```

**Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/plugins/__tests__/slug.test.ts`
Expected: FAIL — cannot resolve `../slug`.

**Step 3: Minimal implementation**

```ts
// src/lib/plugins/slug.ts
/**
 * A plugin slug is kebab-case (`registry-invariants.test.ts` enforces
 * /^[a-z0-9][a-z0-9-]*$/), but its Prisma models are PascalCase-prefixed and the
 * generated client exposes them camelCased — `model PiPlanningCard` becomes
 * `prisma.piPlanningCard`. Anything matching plugin-owned model accessors by slug
 * must go through this, or the match silently never fires for a hyphenated slug.
 */
export function pluginModelPrefix(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
```

**Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/plugins/__tests__/slug.test.ts`
Expected: PASS (4 tests).

**Step 5: Use it in the arch test**

In `src/lib/plugins/__tests__/plugin-isolation.arch.test.ts`, add the import and
change the pattern construction:

```ts
import { pluginModelPrefix } from "../slug";
// ...
    const patterns = slugs.map((s) => new RegExp(`\\bprisma\\.${pluginModelPrefix(s)}[A-Z]`));
```

**Step 6: Verify the whole plugin suite still passes**

Run: `npx vitest run src/lib/plugins/`
Expected: PASS — previously 12 tests, now 16 (4 new).

**Step 7: Commit**

```bash
git add src/lib/plugins/slug.ts src/lib/plugins/__tests__/slug.test.ts \
        src/lib/plugins/__tests__/plugin-isolation.arch.test.ts
git commit -m "fix(plugins): isolation guard silently skipped hyphenated slugs"
```

---

## Task 2: Let vitest see `scripts/plugins/**`

`vitest.config.ts:11-18` includes `src/**`, `scripts/cutover/**`, and
`scripts/dsop/**` — not `scripts/plugins/**`. A test added there in Task 3 would
never run. `scripts/dsop` already includes `.mjs`, so follow that precedent.

**Files:**
- Modify: `vitest.config.ts:16-17`

**Step 1: Add the include entry**

```ts
      "scripts/cutover/**/*.test.{ts,mts}",
      "scripts/dsop/**/*.test.{ts,mts,mjs}",
      "scripts/plugins/**/*.test.{ts,mts,mjs}",
```

**Step 2: Confirm nothing breaks and nothing new is collected yet**

Run: `npx vitest run --reporter=basic 2>&1 | tail -5`
Expected: same pass count as before this task (no test files exist there yet).

**Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test: collect scripts/plugins tests"
```

---

## Task 3: `mergeDependencies` — the pure merge, with fatal conflicts

Conflicts must throw rather than pick a winner. A composed image installs exactly
one version of each package; silently choosing one would produce a build that
differs from what the plugin author tested, and the failure would surface at
runtime in a live event rather than at compose time.

**Files:**
- Create: `scripts/plugins/merge-deps.mjs`
- Create: `scripts/plugins/merge-deps.test.mjs`

**Step 1: Write the failing tests**

```js
// scripts/plugins/merge-deps.test.mjs
import { describe, it, expect } from "vitest";
import { mergeDependencies } from "./merge-deps.mjs";

const core = { next: "16.0.0", react: "19.0.0" };

describe("mergeDependencies", () => {
  it("returns core untouched when no plugin declares dependencies", () => {
    expect(mergeDependencies(core, [{ slug: "a", dependencies: undefined }])).toEqual(core);
  });

  it("adds a plugin dependency", () => {
    const out = mergeDependencies(core, [{ slug: "pi-planning", dependencies: { yjs: "^13.6.27" } }]);
    expect(out.yjs).toBe("^13.6.27");
    expect(out.next).toBe("16.0.0");
  });

  it("allows two plugins to declare the identical range", () => {
    const out = mergeDependencies(core, [
      { slug: "a", dependencies: { yjs: "^13.6.27" } },
      { slug: "b", dependencies: { yjs: "^13.6.27" } },
    ]);
    expect(out.yjs).toBe("^13.6.27");
  });

  it("throws naming both plugins when two want different ranges", () => {
    expect(() =>
      mergeDependencies(core, [
        { slug: "a", dependencies: { yjs: "^13.6.27" } },
        { slug: "b", dependencies: { yjs: "^14.0.0" } },
      ]),
    ).toThrow(/yjs.*a wants \^13\.6\.27.*b wants \^14\.0\.0/s);
  });

  it("throws when a plugin conflicts with a core dependency", () => {
    expect(() =>
      mergeDependencies(core, [{ slug: "a", dependencies: { react: "18.0.0" } }]),
    ).toThrow(/react.*conflicts with core/s);
  });

  it("returns keys sorted so the package.json diff is stable", () => {
    const out = mergeDependencies(core, [{ slug: "a", dependencies: { aaa: "1.0.0", zzz: "1.0.0" } }]);
    expect(Object.keys(out)).toEqual(["aaa", "next", "react", "zzz"]);
  });
});
```

**Step 2: Run and confirm failure**

Run: `npx vitest run scripts/plugins/merge-deps.test.mjs`
Expected: FAIL — cannot resolve `./merge-deps.mjs`.

**Step 3: Implement**

```js
// scripts/plugins/merge-deps.mjs
/**
 * Merge plugin-declared npm dependencies into core's `dependencies` map.
 *
 * A plugin cannot ship its own package.json — the overlay collision guard in
 * sync.mjs rejects any overlay path that is a tracked core file — so
 * `plugin.json.dependencies` is the only sanctioned way for a plugin to add a
 * runtime dependency.
 *
 * Version conflicts are FATAL, never silently resolved: a composed image installs
 * exactly one version of each package, so picking a winner here would build
 * something the plugin author never tested, and the failure would land at runtime.
 *
 * @param {Record<string,string>} coreDeps
 * @param {Array<{slug: string, dependencies?: Record<string,string>}>} plugins
 * @returns {Record<string,string>} merged, key-sorted
 */
export function mergeDependencies(coreDeps, plugins) {
  const merged = { ...coreDeps };
  const claimedBy = new Map(); // package name -> slug that introduced it

  for (const { slug, dependencies } of plugins) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      const existing = merged[name];
      if (existing !== undefined && existing !== range) {
        const owner = claimedBy.get(name);
        throw new Error(
          owner
            ? `[plugin-sync] dependency conflict on "${name}": ${owner} wants ${existing}, ${slug} wants ${range}`
            : `[plugin-sync] ${slug}: dependency "${name}@${range}" conflicts with core's ${existing}`,
        );
      }
      merged[name] = range;
      claimedBy.set(name, slug);
    }
  }

  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}
```

**Step 4: Run and confirm pass**

Run: `npx vitest run scripts/plugins/merge-deps.test.mjs`
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add scripts/plugins/merge-deps.mjs scripts/plugins/merge-deps.test.mjs
git commit -m "feat(plugins): mergeDependencies with fatal conflict detection"
```

---

## Task 4: Make `sync.mjs` worktree-safe

In a git worktree `.git` is a **file**, not a directory (verified:
`gitdir: /…/.git/worktrees/<name>`). `sync.mjs` hardcodes `<root>/.git/info/exclude`
and `<root>/.git/plugin-sync.state`, both of which raise `ENOTDIR` there. The state
write is the *last* thing the script does (`sync.mjs:178`), so a compose inside a
worktree fails **after** the overlay and `schema.prisma` are already modified,
leaving a half-composed tree with no state file to `--clean` with.

Use `--git-common-dir` for `exclude` (git only ever reads the shared one) and
`--git-dir` for the state file (so two worktrees don't clobber each other's).

**Files:**
- Modify: `scripts/plugins/sync.mjs:27-33`

**Step 1: Replace the hardcoded paths**

```js
const ROOT = process.cwd();
const PLUGINS_DIR = join(ROOT, "plugins");
// `.git` is a FILE in a worktree (it holds `gitdir: …`), so joining paths onto it
// raises ENOTDIR. Ask git where things actually live. `exclude` is shared across
// worktrees (git only reads the common dir); the state file is per-worktree so two
// worktrees composing different plugin sets don't clobber each other.
const gitPath = (flag) =>
  execFileSync("git", ["rev-parse", "--path-format=absolute", flag], { cwd: ROOT })
    .toString()
    .trim();
const EXCLUDE = join(gitPath("--git-common-dir"), "info", "exclude");
const STATE = join(gitPath("--git-dir"), "plugin-sync.state");
```

Note `gitPath` must be defined after `ROOT` but before first use, and
`execFileSync` is already imported at `sync.mjs:22`.

**Step 2: Verify in the main checkout (must be unchanged behaviour)**

```bash
node scripts/plugins/sync.mjs && git status --short && node scripts/plugins/sync.mjs --clean && git status --short
```
Expected: `no plugins/ dir — neutral (zero-plugin) build` (or the composed message
if `plugins/` exists), clean `git status` both times.

**Step 3: Verify in a throwaway worktree (this is the regression being fixed)**

```bash
SP="$(mktemp -d)"
git worktree add --detach "$SP/wt-check" HEAD
(cd "$SP/wt-check" && node scripts/plugins/sync.mjs)
git worktree remove --force "$SP/wt-check"
```
Expected: exits 0 (before this task it raises `ENOTDIR`).

**Step 4: Commit**

```bash
git add scripts/plugins/sync.mjs
git commit -m "fix(plugins): sync.mjs assumed .git was a directory, breaking worktrees"
```

---

## Task 5: Wire dependency merging into `sync.mjs`

**Files:**
- Modify: `scripts/plugins/sync.mjs` (imports; the per-plugin loop; after the schema write)

**Step 1: Import the merge helper**

```js
import { mergeDependencies } from "./merge-deps.mjs";
```

**Step 2: Collect declarations in the existing plugin loop**

Beside `manifests`, `schemaFragments`, `backrel`, add:

```js
const pluginDeps = [];            // { slug, dependencies }
```

and inside the `for (const slug of slugs)` loop, after the config is read:

```js
  if (cfg.dependencies) pluginDeps.push({ slug, dependencies: cfg.dependencies });
```

**Step 3: Merge and write package.json, then regenerate the lock**

Insert after the schema write block (after `written.add("prisma/schema.prisma")`):

```js
// --- merge plugin npm dependencies + regenerate the lock ---
// Dockerfile runs `npm ci`, which fails hard when package.json and
// package-lock.json disagree — so writing deps without refreshing the lock would
// produce a composed image that cannot build.
if (pluginDeps.length > 0) {
  const PKG = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const merged = mergeDependencies(pkg.dependencies ?? {}, pluginDeps);
  if (JSON.stringify(merged) !== JSON.stringify(pkg.dependencies)) {
    pkg.dependencies = merged;
    writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
    written.add("package.json");
    console.log(`[plugin-sync] merged plugin dependencies; refreshing package-lock.json`);
    execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    written.add("package-lock.json");
  }
}
```

Both files are tracked, so the existing `trackedWritten` → `--skip-worktree` block
and `restore()`'s `git checkout` handle hiding and reversal with no further change.

**Step 4: Verify the neutral path is untouched**

Run: `node scripts/plugins/sync.mjs && git status --short`
Expected: neutral message, empty `git status`.

**Step 5: Verify with a real declaration (manual, end-to-end)**

Temporarily add `"dependencies": { "yjs": "^13.6.27" }` to
`plugins/foreman/plugin.json`, then:

```bash
node scripts/plugins/sync.mjs
node -p "require('./package.json').dependencies.yjs"     # expect ^13.6.27
node -p "!!require('./package-lock.json').packages['node_modules/yjs']"  # expect true
git status --short                                        # expect EMPTY (skip-worktree)
node scripts/plugins/sync.mjs --clean
node -p "require('./package.json').dependencies.yjs ?? 'absent'"  # expect absent
git status --short                                        # expect EMPTY
```

Then revert the temporary `plugin.json` edit. **Do not commit it.**

**Step 6: Commit**

```bash
git add scripts/plugins/sync.mjs
git commit -m "feat(plugins): compose plugin npm dependencies into package.json + lock"
```

---

## Task 6: Document the contract

**Files:**
- Modify: `scripts/plugins/sync.mjs:1-19` (the header comment — add step 5)
- Modify: `docs/adr/0003-plugin-system.md` (a line under "Shape" noting `dependencies`)

Keep it short. The header comment enumerates what compose does; dependency
merging is now step 5 and should say so, including the lock regeneration and why.

**Commit:** `docs(plugins): record dependency composition in the SDK contract`

---

## Task 7: Full verification, version bump

**Step 1: Neutral core, everything**

```bash
node scripts/plugins/sync.mjs --clean
npx tsc --noEmit
npx vitest run
npm run test:arch
npm run build
```
Expected: tsc 0 errors; all tests pass; arch green; build succeeds.

**Step 2: Bump the patch version**

`package.json` `2.237.1` → `2.237.2`. Per AGENTS.md this is "internal refactors,
dependency bumps" → patch.

**No changelog entry.** `src/lib/changelog.ts:1-5` says entries are user-facing
("describe the value, not the implementation"); build tooling isn't. If CI's
config-assertions job disagrees, add one and note it here.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: 2.237.2"
```

---

## Task 8: Scaffold `cosmos-plugin-pi-planning`

Mirror the layout of an existing full-featured plugin repo (nav group, pages, own
Prisma fragment, `/api` shims). **A no-op plugin** — one nav leaf, one page
that says the plugin is enabled, empty Prisma fragment. No PI planning logic. The
goal is proving the seam, so keep the surface tiny enough that a failure can only
be the seam.

**Files (in the new repo):**

```
plugin.json
prisma/pi-planning.prisma            # empty but present
overlay/src/plugins/pi-planning/manifest.ts
overlay/src/plugins/pi-planning/server.ts
overlay/src/plugins/pi-planning/pages/events.tsx
overlay/src/app/(dashboard)/[orgSlug]/(plugin-pi-planning)/pi-planning/page.tsx
README.md
.github/workflows/notify-assembly.yml
```

`plugin.json`:

```json
{
  "slug": "pi-planning",
  "name": "PI Planning",
  "version": "0.1.0",
  "core": ">=2.237.2 <3",
  "manifest": "src/plugins/pi-planning/manifest.ts",
  "serverHooks": "src/plugins/pi-planning/server.ts",
  "overlay": "overlay",
  "schemaFragment": "prisma/pi-planning.prisma",
  "schemaBackRelations": {}
}
```

Manifest constraints, all arch-enforced:
- `apiVersion: PLUGIN_API_VERSION`, slug `pi-planning`, own semver `0.1.0`
- `minCosmosVersion: "2.237.2"` — must be ≤ `package.json` version
  (`registry-invariants.test.ts:70-81`)
- module `key` === `nav.id` === `"pi-planning"`, `href: "/pi-planning"`
- `anyOf: [Permission.PROJECT_READ]` — core bits only
- no `sectors` (company-agnostic, per the design decision)
- icon: a lucide icon

The route shim must be **≤20 code lines** and import only from `@/plugins/**`,
`react`, or `next/*`. Copy the shape of any existing composed `(plugin-*)` page
shim under `src/app/(dashboard)/[orgSlug]/` — including the Cache Components rule:
pass `params` as a Promise into a Suspense child, never `await` it at the top.

The page must call `isPluginEnabled(orgId, "pi-planning")` and `notFound()` when off.

**Verification (the whole point of the slice):**

```bash
# from the core checkout, with the plugin cloned to plugins/pi-planning
node scripts/plugins/sync.mjs
npx prisma validate
npx prisma generate
npx tsc --noEmit
npx vitest run
npm run test:arch
npm run build
node scripts/plugins/sync.mjs --clean
git status --short          # expect EMPTY
```

Expected: composed build green with a `/pi-planning` route; `--clean` returns the
tree to pristine.

**Manual check:** enable the plugin for an org via Settings → Plugins, confirm the
nav entry appears; disable it, confirm the nav entry disappears and `/pi-planning`
404s. That is the fail-closed contract.

---

## Verification gotchas (found the hard way)

1. **Run the client-identity gate AFTER `git add`.** It scans `git ls-files`, so an
   untracked new file is invisible to it. Running it on an unstaged doc gives a
   false green.
2. **`rm -rf .next` when switching between composed and neutral.** Next generates
   `.next/types/validator.ts` entries for every route; after `--clean` the composed
   route sources are gone and those validators dangle, so `tsc` reports a wall of
   `TS2307 Cannot find module …(plugin-*)…` that is pure staleness, not a
   regression.
3. **A hyphenated slug was never actually supported.** Two independent sites
   interpolated the raw slug where a JS identifier / camelCase accessor was
   required: the isolation guard (silently matched nothing) and the generated
   registry files (hard syntax error). Both fixed; `camelSlug` / `pluginModelPrefix`
   are cross-checked against each other by a parity test.

## Definition of done for Slice 0

- [ ] `pluginModelPrefix` extracted, tested, and used by the isolation guard
- [ ] `scripts/plugins/**` collected by vitest
- [ ] `mergeDependencies` implemented with fatal conflicts, 6 tests passing
- [ ] `sync.mjs` runs inside a git worktree
- [ ] A plugin can declare `dependencies`; `package.json` **and** the lock update; `--clean` reverses both
- [ ] Neutral core green: `tsc`, `vitest`, `test:arch`, `build`
- [ ] `cosmos-plugin-pi-planning` exists (private), composes, and `--clean` leaves the tree pristine
- [ ] Fail-closed verified by hand: nav appears on enable, 404 on disable

---

## Slices 1–2 (outline — plan in detail once Slice 0 is green)

Deliberately not expanded yet. Their task breakdown depends on what the composed
tree actually looks like, and writing bite-sized TDD steps against an unbuilt
schema would be guesswork.

**Slice 1 — Events, teams, roles.** Prisma fragment: `Event`, `EventProject`,
`Iteration`, `IterationInterval`, `Team`, `EventTeam`, `TeamMember`. Back-relations
onto `Organization` and `Project` only. `onFirstEnable` seeds the SAFe `WorkRole`
rows (RTE, PO, SM, PdM, System Architect, Business Owner) and the default
`CardType` taxonomy. API handlers use the `_helpers.ts` guard pattern. Offline
migration via `prisma migrate diff --from-schema … --script`; test with
`migrate deploy` on a fresh DB.

*Acceptance:* create an event spanning two projects, define five iterations with an
IP iteration, create three teams, assign members and roles — all `orgId`-scoped,
all audited.

**Slice 2 — Program board, layer 0 only.** Team×iteration grid from real
`WorkItem`/`Interval` data; capacity and load from `IntervalCapacity` + story
points, reusing `src/lib/intervals/sprint-planning.ts`. Drag a feature to a cell →
API write → `logAudit` → coarse bus event → other browsers refetch.

*Acceptance:* two browsers, one drag, both update; the audit log records who moved
what and when; the plugin is still fail-closed.

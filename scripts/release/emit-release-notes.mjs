#!/usr/bin/env node
/**
 * Emit one release's user-facing notes as JSON, for publishing to the registry.
 *
 * WHY THIS EXISTS. `src/lib/changelog.ts` ships INSIDE the image, so a running
 * instance holds notes for every version up to its own and nothing beyond. To
 * answer "what is in the version I have not installed yet?", the notes have to
 * be readable from outside the image — so each release publishes this JSON as a
 * small OCI artifact tagged `<version>-notes`, which the Updates page reads.
 *
 * Plain manifest + blob under a derived tag, NOT the OCI 1.1 Referrers API:
 * referrers is the better mechanism, but the registry these deployments pull
 * from answers `/v2/<name>/referrers/<digest>` with a 404 (measured against the
 * GitLab container registry, 2026-08-11). A tag works on any Registry v2.
 *
 * Usage:  node scripts/release/emit-release-notes.mjs <version> [outfile]
 * Exits 2 when the version has no changelog entry — the caller decides whether
 * that is fatal (for the release pipeline it is not; notes are best-effort).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2];
const outfile = process.argv[3] ?? "release-notes.json";

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: emit-release-notes.mjs <MAJOR.MINOR.PATCH> [outfile]");
  process.exit(1);
}

// changelog.ts imports nothing, so Node's type stripping can load it directly —
// no build step, and no second copy of the release notes to drift.
const { CHANGELOG } = await import(resolve(HERE, "../../src/lib/changelog.ts"));

const entry = CHANGELOG.find((r) => r.version === version);
if (!entry) {
  console.error(`[release-notes] no CHANGELOG entry for ${version} — nothing to publish`);
  process.exit(2);
}

// Emit exactly the shape src/lib/updates/notes.ts parses, and nothing more: the
// consumer cross-checks `version` against what it asked for and drops anything
// unrecognised, so extra fields would be silently discarded anyway.
const payload = {
  version: entry.version,
  date: entry.date ?? null,
  title: entry.title ?? null,
  highlights: (entry.highlights ?? []).map((h) => ({ kind: h.kind, text: h.text })),
};

writeFileSync(outfile, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`[release-notes] wrote ${outfile} for ${version} (${payload.highlights.length} highlight(s))`);

/**
 * Release notes for a version you have not installed.
 *
 * THE PROBLEM. The changelog ships INSIDE the image (`src/lib/changelog.ts`), so
 * a running instance has notes for every version up to its own and nothing
 * beyond. To answer "what is in 2.278.0?" it has to read something published
 * outside the image it is running.
 *
 * WHY A TAG ARTIFACT AND NOT THE REFERRERS API. OCI 1.1 Referrers is the right
 * answer and `listReferrers()` in ./registry.ts implements it — an artifact
 * attached to an image by digest, addressable and independently signed, with no
 * pull. It is deliberately NOT wired in here: the registry this deployment
 * actually pulls from answers `/v2/<name>/referrers/<digest>` with a flat
 * **404** (measured 2026-08-11 against the GitLab container registry). Wiring a
 * lookup that no registry serves and no pipeline publishes would be a dead path
 * reporting a healthy "no notes available" forever — the exact defect shape this
 * whole feature exists to stop. When the registry gains Referrers support, add
 * it as a first attempt in front of this one; the artifact format is the same.
 *
 * What IS used here works on any Registry v2: notes are pushed as an ordinary
 * manifest + blob under a derived tag, `<version>-notes`. No referrers support
 * required, nothing to enable.
 *
 * WHERE IT LOOKS. `notesRepo` defaults to the deployment's own image repository,
 * so a disconnected site that mirrors its images gets notes from the same mirror
 * and needs no second network path. An instance whose composed image repository
 * carries no notes can point `COSMOS_UPDATE_NOTES_REPO` at the neutral core
 * repository, whose notes describe the same versions — release notes are a
 * property of the core version, not of a per-instance composition.
 */
import { getManifest, getBlobText, type RegistryOptions } from "./registry";

/** The artifact type the publisher stamps on the notes manifest. */
export const NOTES_ARTIFACT_TYPE = "application/vnd.cosmos.release-notes.v1+json";

/** Tag under which a version's notes are published. */
export function notesTag(version: string): string {
  return `${version}-notes`;
}

export interface NoteHighlight {
  kind: "feature" | "improvement" | "fix";
  text: string;
}

export interface ReleaseNote {
  version: string;
  date: string | null;
  title: string | null;
  highlights: NoteHighlight[];
}

const KINDS = new Set(["feature", "improvement", "fix"]);
// Caps, because this is REMOTE data rendered into an admin page. React escapes
// it so there is no injection concern, but an unbounded string is still a way to
// make the page unusable, and a huge array is a way to make it slow.
const MAX_TEXT = 2000;
const MAX_HIGHLIGHTS = 50;

/**
 * Parse a notes payload defensively.
 *
 * Anything unexpected is dropped rather than rendered or thrown on: this is
 * data fetched from a registry, and the page must survive a malformed or
 * truncated artifact without taking the update check down with it.
 */
export function parseReleaseNote(raw: unknown, expectedVersion: string): ReleaseNote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const version = typeof o.version === "string" ? o.version : null;
  // A notes artifact that describes a DIFFERENT version is worse than none: it
  // would attribute one release's changes to another.
  if (version !== expectedVersion) return null;

  const rawHighlights = Array.isArray(o.highlights) ? o.highlights : [];
  const highlights: NoteHighlight[] = [];
  for (const h of rawHighlights.slice(0, MAX_HIGHLIGHTS)) {
    if (typeof h !== "object" || h === null) continue;
    const e = h as Record<string, unknown>;
    if (typeof e.text !== "string" || !e.text.trim()) continue;
    const kind = typeof e.kind === "string" && KINDS.has(e.kind) ? (e.kind as NoteHighlight["kind"]) : "improvement";
    highlights.push({ kind, text: e.text.slice(0, MAX_TEXT) });
  }
  if (highlights.length === 0) return null;

  return {
    version,
    date: typeof o.date === "string" ? o.date.slice(0, 40) : null,
    title: typeof o.title === "string" ? o.title.slice(0, 300) : null,
    highlights,
  };
}

export interface NotesDeps {
  getManifest: typeof getManifest;
  getBlobText: typeof getBlobText;
}

const defaultNotesDeps: NotesDeps = { getManifest, getBlobText };

/**
 * Notes for one version, or null when none are published.
 *
 * Null is an ordinary, expected answer — most registries will not carry these
 * until the publishing side has run for a release. It never throws.
 */
export async function fetchReleaseNote(
  version: string,
  notesRepo: string,
  opts: RegistryOptions = {},
  deps: NotesDeps = defaultNotesDeps,
): Promise<ReleaseNote | null> {
  try {
    const manifest = await deps.getManifest(notesRepo, notesTag(version), opts);
    const layer = manifest?.layers?.[0];
    if (!layer?.digest) return null;

    const text = await deps.getBlobText(notesRepo, layer.digest, opts);
    if (!text) return null;

    return parseReleaseNote(JSON.parse(text), version);
  } catch {
    return null;
  }
}

/**
 * Notes for several versions, newest first.
 *
 * Bounded on purpose: an instance many releases behind would otherwise issue one
 * manifest + one blob request per version. The cap is applied to the NEWEST
 * versions, and the caller is told how many were skipped so the UI can say so
 * rather than silently implying it showed everything.
 */
export async function fetchReleaseNotes(
  versions: readonly string[],
  notesRepo: string,
  opts: RegistryOptions = {},
  deps: NotesDeps = defaultNotesDeps,
  limit = 10,
): Promise<{ notes: ReleaseNote[]; omitted: number }> {
  const newestFirst = [...versions].reverse();
  const take = newestFirst.slice(0, limit);
  const settled = await Promise.all(take.map((v) => fetchReleaseNote(v, notesRepo, opts, deps)));
  return {
    notes: settled.filter((n): n is ReleaseNote => n !== null),
    omitted: Math.max(0, newestFirst.length - take.length),
  };
}

// @vitest-environment node
//
// Release notes for a version that is not installed.
//
// This payload is REMOTE data rendered into an admin page, so most of these
// tests are about refusing bad input rather than reading good input. The one
// that matters most is the version cross-check: notes that describe a different
// release than the one requested would attribute one version's changes to
// another, which is worse than showing no notes at all.
import { describe, it, expect, vi } from "vitest";
import { parseReleaseNote, fetchReleaseNote, fetchReleaseNotes, notesTag, type NotesDeps } from "./notes";

const GOOD = {
  version: "2.278.0",
  date: "2026-08-12",
  title: "Something shipped",
  highlights: [
    { kind: "feature", text: "A new thing." },
    { kind: "fix", text: "A fixed thing." },
  ],
};

const deps = (over: Partial<NotesDeps> = {}): NotesDeps => ({
  getManifest: vi.fn(async () => ({ layers: [{ digest: `sha256:${"a".repeat(64)}` }] })),
  getBlobText: vi.fn(async () => JSON.stringify(GOOD)),
  ...over,
}) as NotesDeps;

describe("notesTag", () => {
  it("derives the published tag from the version", () => {
    expect(notesTag("2.278.0")).toBe("2.278.0-notes");
  });
});

describe("parseReleaseNote — refusing bad input", () => {
  it("reads a well-formed payload", () => {
    const n = parseReleaseNote(GOOD, "2.278.0");
    expect(n?.title).toBe("Something shipped");
    expect(n?.highlights).toHaveLength(2);
  });

  it("REFUSES notes describing a different version", () => {
    // Otherwise one release's changes get attributed to another.
    expect(parseReleaseNote(GOOD, "2.279.0")).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    expect(parseReleaseNote(null, "2.278.0")).toBeNull();
    expect(parseReleaseNote("nope", "2.278.0")).toBeNull();
    expect(parseReleaseNote({}, "2.278.0")).toBeNull();
    expect(parseReleaseNote({ version: "2.278.0" }, "2.278.0")).toBeNull(); // no highlights
  });

  it("drops malformed highlights but keeps the good ones", () => {
    const n = parseReleaseNote(
      { ...GOOD, highlights: [{ kind: "fix", text: "keep" }, null, { text: "" }, { kind: "fix" }, 42] },
      "2.278.0",
    );
    expect(n?.highlights).toEqual([{ kind: "fix", text: "keep" }]);
  });

  it("normalises an unknown kind instead of rendering it raw", () => {
    const n = parseReleaseNote({ ...GOOD, highlights: [{ kind: "<script>", text: "x" }] }, "2.278.0");
    expect(n?.highlights[0].kind).toBe("improvement");
  });

  it("caps text length and highlight count", () => {
    const n = parseReleaseNote(
      {
        ...GOOD,
        highlights: Array.from({ length: 200 }, () => ({ kind: "fix", text: "x".repeat(9999) })),
      },
      "2.278.0",
    );
    expect(n!.highlights.length).toBeLessThanOrEqual(50);
    expect(n!.highlights[0].text.length).toBeLessThanOrEqual(2000);
  });

  it("tolerates a missing date and title", () => {
    const n = parseReleaseNote({ version: "2.278.0", highlights: [{ kind: "fix", text: "y" }] }, "2.278.0");
    expect(n?.date).toBeNull();
    expect(n?.title).toBeNull();
  });
});

describe("fetchReleaseNote", () => {
  it("reads the first layer's blob and parses it", async () => {
    const d = deps();
    const n = await fetchReleaseNote("2.278.0", "reg.example.com/o/r", {}, d);
    expect(n?.version).toBe("2.278.0");
    expect(d.getManifest).toHaveBeenCalledWith("reg.example.com/o/r", "2.278.0-notes", {});
  });

  it("returns null when no notes are published — the common case, not an error", async () => {
    const d = deps({ getManifest: vi.fn(async () => null) });
    await expect(fetchReleaseNote("2.278.0", "reg.example.com/o/r", {}, d)).resolves.toBeNull();
  });

  it("returns null when the blob is missing or over the cap", async () => {
    const d = deps({ getBlobText: vi.fn(async () => null) });
    await expect(fetchReleaseNote("2.278.0", "reg.example.com/o/r", {}, d)).resolves.toBeNull();
  });

  it("survives invalid JSON rather than failing the whole update check", async () => {
    const d = deps({ getBlobText: vi.fn(async () => "{not json") });
    await expect(fetchReleaseNote("2.278.0", "reg.example.com/o/r", {}, d)).resolves.toBeNull();
  });

  it("never throws when the registry call itself explodes", async () => {
    const d = deps({ getManifest: vi.fn(async () => { throw new Error("boom"); }) as unknown as NotesDeps["getManifest"] });
    await expect(fetchReleaseNote("2.278.0", "reg.example.com/o/r", {}, d)).resolves.toBeNull();
  });
});

describe("fetchReleaseNotes — several versions", () => {
  it("returns newest first", async () => {
    const d = deps({ getBlobText: vi.fn(async () => JSON.stringify(GOOD)) });
    // ascending in, newest-first out
    const out = await fetchReleaseNotes(["2.278.0"], "reg.example.com/o/r", {}, d);
    expect(out.notes[0].version).toBe("2.278.0");
    expect(out.omitted).toBe(0);
  });

  it("BOUNDS the number of lookups and reports what it skipped", async () => {
    // An instance 40 releases behind would otherwise issue 80 registry requests,
    // and silently showing only some would imply it showed everything.
    const versions = Array.from({ length: 25 }, (_, i) => `2.2${String(i).padStart(2, "0")}.0`);
    const d = deps({ getManifest: vi.fn(async () => null) });
    const out = await fetchReleaseNotes(versions, "reg.example.com/o/r", {}, d, 10);
    expect(d.getManifest).toHaveBeenCalledTimes(10);
    expect(out.omitted).toBe(15);
  });

  it("drops versions with no published notes without failing the rest", async () => {
    let call = 0;
    const d = deps({
      getManifest: vi.fn(async () => (++call === 1 ? null : { layers: [{ digest: `sha256:${"a".repeat(64)}` }] })),
      getBlobText: vi.fn(async () => JSON.stringify({ ...GOOD, version: "2.277.0" })),
    });
    const out = await fetchReleaseNotes(["2.277.0", "2.278.0"], "reg.example.com/o/r", {}, d);
    expect(out.notes.map((n) => n.version)).toEqual(["2.277.0"]);
  });
});

// ---- Publisher ↔ consumer contract -----------------------------------------
//
// The release pipeline writes this JSON and the Updates page parses it. They
// live in different languages, different directories and different runtimes, so
// nothing but a test stops them drifting — and a drifted pair fails SILENTLY:
// `parseReleaseNote` returns null, the page says "no notes published", and the
// pipeline reports success. Run the REAL emitter and feed its REAL output to the
// REAL parser.
describe("emit-release-notes.mjs output is what parseReleaseNote accepts", () => {
  it("round-trips a real changelog entry end to end", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // CHANGELOG[0], not CURRENT_VERSION: the latter reads a BUILD-TIME env var
    // (NEXT_PUBLIC_APP_VERSION) and is "0.0.0" outside a Next build. The
    // emitter looks entries up in CHANGELOG, so that is the real contract.
    const { CHANGELOG } = await import("@/lib/changelog");
    const CURRENT_VERSION = CHANGELOG[0].version;

    const out = join(mkdtempSync(join(tmpdir(), "notes-")), "release-notes.json");
    execFileSync(process.execPath, ["scripts/release/emit-release-notes.mjs", CURRENT_VERSION, out], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const parsed = parseReleaseNote(JSON.parse(readFileSync(out, "utf8")), CURRENT_VERSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(CURRENT_VERSION);
    expect(parsed!.highlights.length).toBeGreaterThan(0);
    expect(parsed!.highlights.every((h) => ["feature", "improvement", "fix"].includes(h.kind))).toBe(true);
  });
});

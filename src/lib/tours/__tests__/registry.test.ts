// Two things this must never get wrong.
//
// A DISABLED plugin's tour must not be offered — its pages are unreachable for
// that org, so every step would navigate into a wall.
//
// And a deployment that contributes no tours must see NOTHING. The mechanism
// ships to everyone; the content does not, and nobody who has not asked for a
// tour should discover one.
import { describe, expect, it } from "vitest";
import { CORE_TOURS, availableTours, tourById, nextUnseenTour } from "../registry";
import type { PluginManifest } from "@/lib/plugins/registry";
import type { Tour } from "../types";

const tour = (id: string, released: string): Tour => ({
  id,
  name: "T " + id,
  summary: "",
  released,
  steps: [{ id: "a", title: "A", blurb: "b", look: "l" }],
});

const manifest = (slug: string, tours?: Tour[]): PluginManifest =>
  ({ slug, name: slug, version: "1.0.0", modules: [], ...(tours ? { tours } : {}) }) as unknown as PluginManifest;

const NONE: ReadonlySet<string> = new Set();

describe("a deployment that was not given tours sees none", () => {
  it("offers nothing when no plugin contributes", () => {
    expect(availableTours([manifest("alpha"), manifest("beta")], new Set(["alpha", "beta"]))).toEqual([]);
  });

  it("offers nothing with no plugins at all", () => {
    expect(availableTours([], NONE)).toEqual([]);
    expect(nextUnseenTour([], NONE, NONE)).toBeUndefined();
  });

  it("ships no core tours, so core alone is silent", () => {
    expect(CORE_TOURS).toEqual([]);
  });
});

describe("enablement gates the offer", () => {
  it("offers an enabled plugin's tour", () => {
    const out = availableTours([manifest("alpha", [tour("t1", "2026-01-01")])], new Set(["alpha"]));
    expect(out.map((t) => t.id)).toEqual(["t1"]);
  });

  it("withholds a DISABLED plugin's tour", () => {
    expect(availableTours([manifest("alpha", [tour("t1", "2026-01-01")])], NONE)).toEqual([]);
  });

  it("withholds it from tourById too, so a link cannot bypass the gate", () => {
    expect(tourById("t1", [manifest("alpha", [tour("t1", "2026-01-01")])], NONE)).toBeUndefined();
  });
});

describe("ordering and selection", () => {
  it("sorts newest first, across plugins", () => {
    const out = availableTours(
      [
        manifest("alpha", [tour("old", "2026-01-01")]),
        manifest("beta", [tour("new", "2026-06-01")]),
      ],
      new Set(["alpha", "beta"]),
    );
    expect(out.map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("nextUnseenTour skips what has been offered and falls to the next", () => {
    const m = [manifest("alpha", [tour("new", "2026-06-01"), tour("old", "2026-01-01")])];
    const on = new Set(["alpha"]);
    expect(nextUnseenTour(m, on, NONE)?.id).toBe("new");
    expect(nextUnseenTour(m, on, new Set(["new"]))?.id).toBe("old");
    expect(nextUnseenTour(m, on, new Set(["new", "old"]))).toBeUndefined();
  });

  it("finds a specific tour by id", () => {
    const m = [manifest("alpha", [tour("t1", "2026-01-01")])];
    expect(tourById("t1", m, new Set(["alpha"]))?.id).toBe("t1");
    expect(tourById("nope", m, new Set(["alpha"]))).toBeUndefined();
  });
});

describe("core tours, whenever there are some", () => {
  it("use org-relative hrefs and unique step ids", () => {
    // The card prefixes the org slug. An absolute href would escape the tenant;
    // a bare word would resolve against whatever page they happen to be on.
    for (const t of CORE_TOURS) {
      const ids = t.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of t.steps) {
        if (s.href === undefined) continue;
        expect(s.href.startsWith("/")).toBe(true);
        expect(s.href.startsWith("//")).toBe(false);
        expect(s.href).not.toMatch(/^https?:/);
      }
    }
  });
});

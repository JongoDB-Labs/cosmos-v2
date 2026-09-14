// Two things this must never get wrong.
//
// A DISABLED plugin's tour must not be offered — its pages are unreachable for
// that org, so every step would navigate into a wall.
//
// And a deployment that contributes no tours must see NOTHING. The mechanism
// ships to everyone; the content does not, and nobody who has not asked for a
// tour should discover one.
import { describe, expect, it } from "vitest";
import { CORE_TOURS, availableTours, tourById, nextUnseenTour, stepAllowed, tourFor } from "../registry";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
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
// Every permission bit set: existing cases are about enablement, not role.
const ALL = -1n;

describe("a deployment that was not given tours sees none", () => {
  it("offers nothing when no plugin contributes", () => {
    expect(availableTours([manifest("alpha"), manifest("beta")], new Set(["alpha", "beta"]), ALL)).toEqual([]);
  });

  it("offers nothing with no plugins at all", () => {
    expect(availableTours([], NONE, ALL)).toEqual([]);
    expect(nextUnseenTour([], NONE, NONE, ALL)).toBeUndefined();
  });

  it("ships no core tours, so core alone is silent", () => {
    expect(CORE_TOURS).toEqual([]);
  });
});

describe("enablement gates the offer", () => {
  it("offers an enabled plugin's tour", () => {
    const out = availableTours([manifest("alpha", [tour("t1", "2026-01-01")])], new Set(["alpha"]), ALL);
    expect(out.map((t) => t.id)).toEqual(["t1"]);
  });

  it("withholds a DISABLED plugin's tour", () => {
    expect(availableTours([manifest("alpha", [tour("t1", "2026-01-01")])], NONE, ALL)).toEqual([]);
  });

  it("withholds it from tourById too, so a link cannot bypass the gate", () => {
    expect(tourById("t1", [manifest("alpha", [tour("t1", "2026-01-01")])], NONE, ALL)).toBeUndefined();
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
      ALL,
    );
    expect(out.map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("nextUnseenTour skips what has been offered and falls to the next", () => {
    const m = [manifest("alpha", [tour("new", "2026-06-01"), tour("old", "2026-01-01")])];
    const on = new Set(["alpha"]);
    expect(nextUnseenTour(m, on, NONE, ALL)?.id).toBe("new");
    expect(nextUnseenTour(m, on, new Set(["new"]), ALL)?.id).toBe("old");
    expect(nextUnseenTour(m, on, new Set(["new", "old"]), ALL)).toBeUndefined();
  });

  it("finds a specific tour by id", () => {
    const m = [manifest("alpha", [tour("t1", "2026-01-01")])];
    expect(tourById("t1", m, new Set(["alpha"]), ALL)?.id).toBe("t1");
    expect(tourById("nope", m, new Set(["alpha"]), ALL)).toBeUndefined();
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

// A walkthrough is a sales surface as much as a teaching one. Sending a reader
// to a page their role redirects away from makes the walkthrough the place they
// find out they are not trusted with it — worse than never offering the step.
describe("steps a role cannot reach are withheld", () => {
  const mixed = (): Tour => ({
    id: "mixed",
    name: "Mixed",
    summary: "",
    released: "2026-06-01",
    steps: [
      { id: "open", title: "Open", blurb: "b", look: "l" },
      { id: "admin", title: "Admin", blurb: "b", look: "l", anyOf: [Permission.ORG_UPDATE] },
    ],
  });

  it("keeps an unrestricted step for everybody", () => {
    expect(stepAllowed({ id: "x", title: "", blurb: "", look: "" }, 0n)).toBe(true);
  });

  it("drops the restricted step for a role without the permission", () => {
    const out = availableTours([manifest("alpha", [mixed()])], new Set(["alpha"]), RolePermissions.MEMBER);
    expect(out[0].steps.map((s) => s.id)).toEqual(["open"]);
  });

  it("keeps it for a role that holds the permission", () => {
    const out = availableTours([manifest("alpha", [mixed()])], new Set(["alpha"]), RolePermissions.ADMIN);
    expect(out[0].steps.map((s) => s.id)).toEqual(["open", "admin"]);
  });

  it("withholds the tour entirely when no step survives", () => {
    const adminOnly: Tour = {
      ...mixed(),
      steps: [{ id: "admin", title: "A", blurb: "b", look: "l", anyOf: [Permission.ORG_UPDATE] }],
    };
    expect(availableTours([manifest("alpha", [adminOnly])], new Set(["alpha"]), RolePermissions.VIEWER)).toEqual([]);
    expect(tourFor(adminOnly, RolePermissions.VIEWER)).toBeUndefined();
  });

  it("does not mutate the tour it filters", () => {
    const t = mixed();
    tourFor(t, RolePermissions.MEMBER);
    expect(t.steps).toHaveLength(2);
  });
});

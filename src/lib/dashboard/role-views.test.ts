// @vitest-environment node
//
// Role presets as a VIEW MODEL — presets that select, not presets that reorder.
//
// The tests that matter here are the ones proving the model does the two things
// a decoration-only version would not: it omits panels a role does not need, and
// it refuses to show a panel that cannot yet say anything true.
import { describe, it, expect } from "vitest";
import {
  PANELS,
  ROLE_VIEWS,
  panelsForRole,
  panelsForScope,
  panelAvailability,
  type PanelId,
} from "./role-views";

describe("the model SELECTS rather than reorders", () => {
  it("gives different roles genuinely different panels, not the same set shuffled", () => {
    const sm = new Set(panelsForRole("scrum-master", "sprint").map((p) => p.id));
    const pm = new Set(panelsForRole("product-manager", "sprint").map((p) => p.id));

    // If presets only reordered, these would be equal as sets.
    expect(sm).not.toEqual(pm);
    // And each must actually EXCLUDE something the other has.
    expect([...sm].some((id) => !pm.has(id))).toBe(true);
    expect([...pm].some((id) => !sm.has(id))).toBe(true);
  });

  it("opens each role on the panel it came to read", () => {
    // Order is meaning: the first panel is the answer to the role's first
    // question, not an alphabetical accident.
    expect(panelsForRole("scrum-master", "sprint")[0].id).toBe("burndown");
    expect(panelsForRole("product-owner", "sprint")[0].id).toBe("commitment-vs-completed");
    expect(panelsForRole("rte", "pi")[0].id).toBe("pi-progress");
    expect(panelsForRole("product-manager", "sprint")[0].id).toBe("velocity-trend");
  });

  it("preserves the role's declared order rather than the registry's", () => {
    const rte = panelsForRole("rte", "pi").map((p) => p.id);
    expect(rte.indexOf("pi-objectives")).toBeLessThan(rte.indexOf("predictability"));
  });
});

describe("scope is part of the model", () => {
  it("drops increment-only panels at sprint scope", () => {
    const ids = panelsForRole("rte", "sprint").map((p) => p.id);
    // A PI burndown charts a container that holds no work of its own.
    expect(ids).not.toContain("pi-progress");
    expect(ids).not.toContain("pi-objectives");
    expect(ids).not.toContain("sprint-contribution");
    // …but the role keeps everything that IS meaningful per sprint.
    expect(ids).toContain("predictability");
  });

  it("drops sprint-only panels at increment scope", () => {
    const ids = panelsForScope("pi").map((p) => p.id);
    expect(ids).not.toContain("burndown");
    expect(ids).not.toContain("workload");
  });

  it("never invents a panel a role did not ask for", () => {
    for (const view of ROLE_VIEWS) {
      if (view.key === "everything") continue;
      for (const scope of ["sprint", "pi"] as const) {
        const got = panelsForRole(view.key, scope).map((p) => p.id);
        expect(got.every((id) => view.panels.includes(id))).toBe(true);
      }
    }
  });
});

describe("'Everything' is derived, never enumerated", () => {
  it("includes every panel valid at the scope", () => {
    // A hand-written all-panels list is the one that silently goes stale the
    // first time someone adds a panel. This asserts it cannot.
    for (const scope of ["sprint", "pi"] as const) {
      const everything = panelsForRole("everything", scope).map((p) => p.id).sort();
      const valid = panelsForScope(scope).map((p) => p.id).sort();
      expect(everything).toEqual(valid);
    }
  });

  it("carries no hardcoded panel list on the view itself", () => {
    expect(ROLE_VIEWS.find((v) => v.key === "everything")!.panels).toEqual([]);
  });
});

describe("a panel states what it needs instead of drawing nothing", () => {
  it("marks a panel NOT ready when there is too little history, with the shortfall", () => {
    // Predictability measures spread; spread over one sample is not a number
    // anyone should act on.
    const [pred] = panelAvailability([PANELS.predictability], 1);
    expect(pred.ready).toBe(false);
    expect(pred.shortfall).toEqual({ needs: 5, has: 1 });
  });

  it("keeps the panel in the list rather than hiding it", () => {
    // A reader who cannot FIND predictability concludes the product lacks it.
    // One that says "needs 5 completed sprints, has 1" teaches them something.
    const out = panelAvailability(panelsForRole("product-manager", "sprint"), 0);
    expect(out.map((o) => o.panel.id)).toContain("predictability");
    expect(out.find((o) => o.panel.id === "predictability")!.ready).toBe(false);
  });

  it("marks in-flight panels ready with no history at all", () => {
    // A burndown of the sprint you are in needs no completed sprints; gating it
    // would leave a brand-new team with a blank board.
    const [burndown] = panelAvailability([PANELS.burndown], 0);
    expect(burndown.ready).toBe(true);
    expect(burndown.shortfall).toBeUndefined();
  });

  it("becomes ready exactly at the threshold, not one past it", () => {
    expect(panelAvailability([PANELS["velocity-trend"]], 2)[0].ready).toBe(false);
    expect(panelAvailability([PANELS["velocity-trend"]], 3)[0].ready).toBe(true);
  });
});

describe("the registry itself stays coherent", () => {
  it("every panel a role names actually exists", () => {
    // A typo'd PanelId would otherwise silently vanish from that role's view.
    for (const view of ROLE_VIEWS) {
      for (const id of view.panels) {
        expect(PANELS[id], `${view.key} names unknown panel ${id}`).toBeDefined();
      }
    }
  });

  it("every panel is reachable from at least one role", () => {
    // Not counting "everything" — a panel only reachable there is one nobody
    // was building for.
    const claimed = new Set<PanelId>(
      ROLE_VIEWS.filter((v) => v.key !== "everything").flatMap((v) => v.panels),
    );
    const orphans = Object.keys(PANELS).filter((id) => !claimed.has(id as PanelId));
    expect(orphans).toEqual([]);
  });

  it("every panel states the question it answers", () => {
    for (const p of Object.values(PANELS)) {
      expect(p.question.length, `${p.id} has no question`).toBeGreaterThan(10);
      expect(p.question).toMatch(/\?$/);
    }
  });
});

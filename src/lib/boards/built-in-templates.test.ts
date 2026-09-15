import { describe, it, expect } from "vitest";
import { BoardType } from "@prisma/client";
import {
  BUILT_IN_BOARD_TEMPLATES,
  boardTypeTemplates,
} from "./built-in-templates";
import { BOARD_TYPE_REGISTRY } from "./board-types";

/**
 * The board-type registry made a type impossible to add without a label and a
 * view. It did NOT make it possible to CREATE one: the board gallery builds from
 * this template catalogue, which was a separate hardcoded list. A type missing
 * from it exists, renders, and is unreachable — the feature ships and no user
 * can get to it.
 *
 * This is the same failure the registry exists to prevent, one list further out.
 */

describe("built-in board templates", () => {
  it("offers a template for every board type, so none is uncreatable", () => {
    const offered = new Set(boardTypeTemplates().map((t) => t.boardType));
    for (const t of Object.values(BoardType)) {
      expect(offered.has(t), `no template creates a ${t} board`).toBe(true);
    }
  });

  it("names every board template with a type the registry knows", () => {
    for (const t of boardTypeTemplates()) {
      expect(
        BOARD_TYPE_REGISTRY[t.boardType],
        `template ${t.slug} builds an unknown board type`
      ).toBeDefined();
    }
  });

  it("still carries the feature templates, which create no board at all", () => {
    // pm-dashboard enables a project feature instead. Coverage must not be
    // satisfied — or broken — by these.
    const features = BUILT_IN_BOARD_TEMPLATES.filter((t) => "feature" in t);
    expect(features.length).toBeGreaterThan(0);
  });

  it("gives every template a unique slug", () => {
    // The slug is what the gallery keys on and what the created board's URL
    // derives from; a duplicate would make one template unreachable.
    const slugs = BUILT_IN_BOARD_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("default columns", () => {
  it("gives a retro board its columns, so the ceremony is usable when created", () => {
    // Board creation seeds no columns. Without defaults a new Sprint Review
    // board opens with nowhere to put a note.
    const review = BOARD_TYPE_REGISTRY.SPRINT_REVIEW.defaultColumns;
    expect(review?.map((c) => c.key)).toEqual(["start", "stop", "continue"]);
  });

  it("gives every retro column a distinct colour for its dot", () => {
    const cols = BOARD_TYPE_REGISTRY.SPRINT_REVIEW.defaultColumns ?? [];
    expect(new Set(cols.map((c) => c.color)).size).toBe(cols.length);
  });

  it("leaves delivery boards alone — their columns are the team's workflow", () => {
    // Seeding opinionated columns onto a Kanban board would fight whatever the
    // project template already set up.
    expect(BOARD_TYPE_REGISTRY.KANBAN.defaultColumns).toBeUndefined();
  });
});

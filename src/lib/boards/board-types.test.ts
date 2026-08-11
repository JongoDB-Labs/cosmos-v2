import { describe, it, expect } from "vitest";
import { BoardType } from "@prisma/client";
import {
  BOARD_TYPE_REGISTRY,
  BOARD_TYPE_ORDER,
  boardTypeLabel,
  savableFromViewTypes,
} from "./board-types";

/**
 * Board types were previously spelled out in three unlinked places: the Prisma
 * enum, `BOARD_TYPE_OPTIONS` in project settings, and `BOARD_TYPES` in the
 * save-as-board dialog. Nothing derived from anything, so a type could exist in
 * the database and be uncreatable in the UI — invisible until a user asked
 * where their board went.
 *
 * These tests guard the single registry that replaced them.
 */

describe("board type registry", () => {
  const members = Object.values(BoardType);

  it("covers every enum member, so none can reach a screen unlabelled", () => {
    for (const t of members) {
      expect(BOARD_TYPE_REGISTRY[t]?.label, `no label for ${t}`).toBeTruthy();
      expect(
        BOARD_TYPE_REGISTRY[t]?.description,
        `no description for ${t}`
      ).toBeTruthy();
    }
  });

  it("offers every member in the picker order, exactly once", () => {
    expect([...BOARD_TYPE_ORDER].sort()).toEqual([...members].sort());
    expect(new Set(BOARD_TYPE_ORDER).size).toBe(BOARD_TYPE_ORDER.length);
  });

  it("keeps the labels users already know", () => {
    // e2e specs locate boards by accessible name, so this copy is a contract.
    expect(BOARD_TYPE_REGISTRY.KANBAN.label).toBe("Kanban");
    expect(BOARD_TYPE_REGISTRY.TIMELINE.label).toBe("Timeline / Gantt");
    expect(BOARD_TYPE_REGISTRY.CFD.label).toBe("Cumulative Flow");
  });
});

describe("savableFromViewTypes", () => {
  it("offers only types that render a list of work items", () => {
    // "Save as board" starts from a filtered work-item view, so it can only
    // produce a board that shows work items. A ceremony or a chart cannot be
    // built from a filter.
    expect(savableFromViewTypes()).toEqual([BoardType.KANBAN, BoardType.TABLE]);
  });

  it("is a subset of the registry, never a parallel list", () => {
    for (const t of savableFromViewTypes()) {
      expect(BOARD_TYPE_REGISTRY[t].savableFromView).toBe(true);
    }
  });
});

describe("boardTypeLabel", () => {
  it("reads as prose, not as a database value", () => {
    expect(boardTypeLabel(BoardType.RAID)).toBe("RAID Log");
  });

  it("falls back to the raw value rather than rendering blank", () => {
    // A board row written before a type was retired should still show SOMETHING.
    expect(boardTypeLabel("LEGACY_THING")).toBe("LEGACY_THING");
  });
});

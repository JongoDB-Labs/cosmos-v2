import { describe, it, expect } from "vitest";
import { BoardType } from "@prisma/client";
import { BOARD_VIEWS } from "./board-renderer";

/**
 * The renderer used to `switch` on the board type with `default:` returning the
 * Kanban board. A type added to the enum but not to the switch therefore did not
 * fail — it rendered the WRONG board, silently, and looked like a working
 * feature. This test and the total Record that replaced the switch exist to make
 * that omission impossible.
 */

describe("board view map", () => {
  it("renders a view for every board type, so none can fall through to Kanban", () => {
    for (const t of Object.values(BoardType)) {
      expect(BOARD_VIEWS[t], `no view registered for ${t}`).toBeTypeOf(
        "function"
      );
    }
  });

  it("has no entry that is not a board type", () => {
    // A stray key means a view nothing can ever route to.
    expect(Object.keys(BOARD_VIEWS).sort()).toEqual(
      Object.values(BoardType).sort()
    );
  });
});

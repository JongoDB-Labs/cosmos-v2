import { describe, it, expect } from "vitest";
import { classifyInstruction, combineIntents } from "./intent";

describe("classifyInstruction", () => {
  describe("approve variants", () => {
    it("classifies plain 'approve' as approve", () => {
      expect(classifyInstruction("approve")).toBe("approve");
    });

    it("classifies 'Approved!' as approve", () => {
      expect(classifyInstruction("Approved!")).toBe("approve");
    });

    it("classifies 'LGTM' as approve", () => {
      expect(classifyInstruction("LGTM")).toBe("approve");
    });

    it("classifies 'ship it' as approve", () => {
      expect(classifyInstruction("ship it")).toBe("approve");
    });

    it("classifies 'shipit' (no space) as approve", () => {
      expect(classifyInstruction("shipit")).toBe("approve");
    });

    it("classifies '👍' emoji as approve", () => {
      expect(classifyInstruction("👍")).toBe("approve");
    });

    it("classifies ':+1:' emoji shortcode as approve", () => {
      expect(classifyInstruction(":+1:")).toBe("approve");
    });

    it("classifies mention token + approve as approve", () => {
      expect(classifyInstruction("<@123e4567-e89b-12d3-a456-426614174000> approve")).toBe(
        "approve",
      );
    });

    it("classifies @Foreman mention + approve as approve (case-insensitive)", () => {
      expect(classifyInstruction("@Foreman approve.")).toBe("approve");
    });

    it("classifies @foreman (lowercase) as approve", () => {
      expect(classifyInstruction("@foreman approve")).toBe("approve");
    });

    it("classifies mention with surrounding punctuation as approve", () => {
      expect(classifyInstruction("<@123e4567-e89b-12d3-a456-426614174000>. approve")).toBe(
        "approve",
      );
    });
  });

  describe("NOT approve (requires full-match after strip)", () => {
    it("classifies 'approve the second option after fixing the header' as instruct", () => {
      expect(classifyInstruction("approve the second option after fixing the header")).toBe(
        "instruct",
      );
    });

    it("classifies 'I approve of the direction but change X' as instruct", () => {
      expect(classifyInstruction("I approve of the direction but change X")).toBe("instruct");
    });

    it("classifies 'approved. but also change the header' as instruct", () => {
      expect(classifyInstruction("approved. but also change the header")).toBe("instruct");
    });
  });

  describe("hedged punctuation (no false-positive approve)", () => {
    it("classifies 'approve?' as instruct (hedge, not approval)", () => {
      expect(classifyInstruction("approve?")).toBe("instruct");
    });

    it("classifies 'approve,' as instruct (fragment, not approval)", () => {
      expect(classifyInstruction("approve,")).toBe("instruct");
    });

    it("classifies 'lgtm?' as instruct (hedge)", () => {
      expect(classifyInstruction("lgtm?")).toBe("instruct");
    });

    it("classifies 'ship it?' as instruct (hedge)", () => {
      expect(classifyInstruction("ship it?")).toBe("instruct");
    });

    it("classifies 'approve.' as approve (regex tolerates period)", () => {
      expect(classifyInstruction("approve.")).toBe("approve");
    });

    it("classifies 'approve!' as approve (regex tolerates exclamation)", () => {
      expect(classifyInstruction("approve!")).toBe("approve");
    });

    it("classifies mention token with colon separator + approve", () => {
      expect(classifyInstruction("<@123e4567-e89b-12d3-a456-426614174000>: approve")).toBe(
        "approve",
      );
    });

    it("classifies 'approve\\n\\nalso fix the header' as instruct (multi-line with content)", () => {
      expect(classifyInstruction("approve\n\nalso fix the header")).toBe("instruct");
    });

    it("classifies 'don't approve yet' as instruct", () => {
      expect(classifyInstruction("don't approve yet")).toBe("instruct");
    });

    it("classifies 'never approve this' as instruct", () => {
      expect(classifyInstruction("never approve this")).toBe("instruct");
    });
  });

  describe("rebuild variants (standalone command, full-match)", () => {
    it("classifies 'rebuild' as rebuild", () => {
      expect(classifyInstruction("rebuild")).toBe("rebuild");
    });

    it("classifies 'please start over' as rebuild", () => {
      expect(classifyInstruction("please start over")).toBe("rebuild");
    });

    it("classifies 'start over' as rebuild", () => {
      expect(classifyInstruction("start over")).toBe("rebuild");
    });

    it("classifies 'from scratch' as rebuild", () => {
      expect(classifyInstruction("from scratch")).toBe("rebuild");
    });

    it("classifies with mention token and rebuild as rebuild", () => {
      expect(classifyInstruction("<@123e4567-e89b-12d3-a456-426614174000> rebuild")).toBe(
        "rebuild",
      );
    });
  });

  describe("default instruct", () => {
    it("classifies 'tighten the copy on the banner' as instruct", () => {
      expect(classifyInstruction("tighten the copy on the banner")).toBe("instruct");
    });

    it("classifies empty string as instruct", () => {
      expect(classifyInstruction("")).toBe("instruct");
    });

    it("classifies whitespace-only as instruct", () => {
      expect(classifyInstruction("   ")).toBe("instruct");
    });

    it("classifies mention token alone as instruct", () => {
      expect(classifyInstruction("<@123e4567-e89b-12d3-a456-426614174000>")).toBe("instruct");
    });

    it("classifies @foreman alone as instruct", () => {
      expect(classifyInstruction("@foreman")).toBe("instruct");
    });
  });

  describe("rebuild keyword matching (must be a standalone command)", () => {
    it("classifies 'requeue' as rebuild (standalone, not a substring)", () => {
      expect(classifyInstruction("requeue")).toBe("rebuild");
    });

    it("does not match 'rebuilding' as rebuild (full-match required)", () => {
      // "rebuilding" is not the standalone command "rebuild"
      expect(classifyInstruction("rebuilding")).toBe("instruct");
    });

    it("classifies 'prebuild the assets' as instruct (prebuild is not a keyword)", () => {
      expect(classifyInstruction("prebuild the assets")).toBe("instruct");
    });

    it("does not match 'requeued' as rebuild (substring in different word)", () => {
      // The anchored pattern never fires inside a larger word/sentence
      expect(classifyInstruction("this was requeued before")).toBe("instruct");
    });
  });

  // Regression: a rebuild keyword mentioned mid-sentence (or hedged/negated) must
  // NOT tear down and requeue the parked build the maintainer is trying to refine.
  // Rebuild fires only when the comment IS a standalone rebuild command.
  describe("rebuild anchoring (mid-sentence / hedged mentions do not tear down)", () => {
    it("classifies 'no need to rebuild everything' as instruct", () => {
      expect(classifyInstruction("no need to rebuild everything")).toBe("instruct");
    });

    it("classifies 'tweak the copy — no need to rebuild everything' as instruct", () => {
      expect(classifyInstruction("tweak the copy — no need to rebuild everything")).toBe(
        "instruct",
      );
    });

    it("classifies \"let's not start over, just fix the header\" as instruct", () => {
      expect(classifyInstruction("let's not start over, just fix the header")).toBe("instruct");
    });

    it("classifies 'do it from scratch' as instruct (leading verb phrase → not standalone)", () => {
      // Previously matched the loose substring pattern and forced a rebuild; the
      // anchored pattern rides it in as an instruction instead of a teardown.
      expect(classifyInstruction("do it from scratch")).toBe("instruct");
    });

    it("classifies 'requeue this' as instruct (trailing object → not standalone)", () => {
      expect(classifyInstruction("requeue this")).toBe("instruct");
    });

    it("classifies 'Rebuild.' as rebuild (standalone, trailing period tolerated)", () => {
      expect(classifyInstruction("Rebuild.")).toBe("rebuild");
    });

    it("classifies 'please rebuild' as rebuild (standalone command)", () => {
      expect(classifyInstruction("please rebuild")).toBe("rebuild");
    });
  });
});

describe("combineIntents", () => {
  it("returns approve with empty instructions if any approve", () => {
    expect(combineIntents(["approve", "tighten the copy"])).toEqual({
      intent: "approve",
      instructions: [],
    });
  });

  it("returns rebuild with all texts if any rebuild and no approve", () => {
    expect(combineIntents(["tighten the copy", "rebuild"])).toEqual({
      intent: "rebuild",
      instructions: ["tighten the copy", "rebuild"],
    });
  });

  it("returns instruct with all texts if no approve or rebuild", () => {
    expect(combineIntents(["tighten the copy", "fix the font"])).toEqual({
      intent: "instruct",
      instructions: ["tighten the copy", "fix the font"],
    });
  });

  it("returns approve with empty instructions when any text is approve variant", () => {
    expect(combineIntents(["LGTM", "also fix the button"])).toEqual({
      intent: "approve",
      instructions: [],
    });
  });

  it("maintains text order in instructions", () => {
    expect(combineIntents(["first", "second", "third"])).toEqual({
      intent: "instruct",
      instructions: ["first", "second", "third"],
    });
  });

  it("prioritizes approve over rebuild", () => {
    expect(combineIntents(["rebuild", "LGTM"])).toEqual({
      intent: "approve",
      instructions: [],
    });
  });

  it("approve still wins over a standalone rebuild command in a batch", () => {
    expect(combineIntents(["please rebuild", "approve"])).toEqual({
      intent: "approve",
      instructions: [],
    });
  });

  it("does not force rebuild when a text only mentions rebuild mid-sentence", () => {
    expect(combineIntents(["no need to rebuild everything"])).toEqual({
      intent: "instruct",
      instructions: ["no need to rebuild everything"],
    });
  });

  it("handles single text", () => {
    expect(combineIntents(["fix the header"])).toEqual({
      intent: "instruct",
      instructions: ["fix the header"],
    });
  });

  it("handles empty array", () => {
    expect(combineIntents([])).toEqual({
      intent: "instruct",
      instructions: [],
    });
  });
});

import { honorPhaseCommand } from "./intent";

describe("honorPhaseCommand", () => {
  it("honors a rebuild on a coordinated phase child in `done`", () => {
    expect(honorPhaseCommand("done", "rebuild", true)).toBe(true);
  });
  it("honors an approve on a coordinated phase child in `done`", () => {
    expect(honorPhaseCommand("done", "approve", true)).toBe(true);
  });
  it("honors a rebuild on a coordinated phase child in any non-review column", () => {
    expect(honorPhaseCommand("backlog", "rebuild", true)).toBe(true);
    expect(honorPhaseCommand("todo", "rebuild", true)).toBe(true);
  });
  it("does NOT honor a bare instruct off review (stays Q&A)", () => {
    expect(honorPhaseCommand("done", "instruct", true)).toBe(false);
  });
  it("does NOT honor when the ticket is in `review` (the normal router owns it)", () => {
    expect(honorPhaseCommand("review", "rebuild", true)).toBe(false);
    expect(honorPhaseCommand("review", "approve", true)).toBe(false);
  });
  it("does NOT honor on a non-coordinated-phase ticket", () => {
    expect(honorPhaseCommand("done", "rebuild", false)).toBe(false);
    expect(honorPhaseCommand("done", "approve", false)).toBe(false);
  });
});

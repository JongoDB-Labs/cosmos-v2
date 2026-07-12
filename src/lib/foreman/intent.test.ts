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

  describe("rebuild variants", () => {
    it("classifies 'rebuild' as rebuild", () => {
      expect(classifyInstruction("rebuild")).toBe("rebuild");
    });

    it("classifies 'please start over' as rebuild", () => {
      expect(classifyInstruction("please start over")).toBe("rebuild");
    });

    it("classifies 'do it from scratch' as rebuild", () => {
      expect(classifyInstruction("do it from scratch")).toBe("rebuild");
    });

    it("classifies 'requeue this' as rebuild", () => {
      expect(classifyInstruction("requeue this")).toBe("rebuild");
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

  describe("rebuild keyword matching (whole-word only)", () => {
    it("classifies 'requeue' as rebuild (not substring)", () => {
      expect(classifyInstruction("requeue")).toBe("rebuild");
    });

    it("does not match 'rebuilding' as rebuild (exact word)", () => {
      // This should be "instruct" since "rebuild" must be a whole word
      expect(classifyInstruction("rebuilding")).toBe("instruct");
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

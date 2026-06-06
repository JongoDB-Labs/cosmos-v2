// src/lib/classification/__tests__/markings.test.ts
import { describe, it, expect } from "vitest";
import { detectMarkings } from "../markings";

describe("detectMarkings", () => {
  it("flags banner-style CUI / FOUO / NOFORN markings", () => {
    for (const s of [
      "CUI//SP-PROPIN",
      "This doc is CUI//SP-PRVCY and must be controlled",
      "FOUO — internal only",
      "//FOUO",
      "Distribution NOFORN",
      "CONTROLLED UNCLASSIFIED INFORMATION",
      "Classification: CUI",
      "Law Enforcement Sensitive",   // LES spelled out (must not be missed)
      "marked //LES here",           // LES portion mark
      "(LES)",                       // LES parenthetical mark
    ]) expect(detectMarkings(s), s).toBe(true);
  });

  it("does NOT flag ordinary prose / substrings (incl. the 'Les'/'les' name trap)", () => {
    for (const s of [
      "summarize the open tasks",
      "the acuity of the issue",   // 'cui' substring, not a marking
      "foul play afoot",           // 'fou' substring
      "fournier needs review",
      "Les Johnson reviewed the tasks",  // 'Les' is a NAME, not a marking
      "les valeurs du projet",           // French 'les', not a marking
      "files were updated",              // 'les' substring
      "",
    ]) expect(detectMarkings(s), s).toBe(false);
  });

  it("scans inside objects (stringifies) and fails closed on unserializable", () => {
    expect(detectMarkings({ note: "x", body: "CUI//SP" })).toBe(true);
    const circ: Record<string, unknown> = { a: 1 }; circ.self = circ;
    expect(detectMarkings(circ)).toBe(true); // unserializable ⇒ fail-closed deny
  });
});

import { describe, expect, it } from "vitest";
import {
  ENTITY_TYPES,
  ENTITY_PREFIX,
  ENTITY_LABEL,
  ENTITY_LABEL_PLURAL,
  ENTITY_ORDER,
  TOKEN_RE,
  buildToken,
  parseRefs,
  refKey,
  isEntityType,
  type EntityType,
} from "./refs";

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("buildToken", () => {
  it("serializes a person as the legacy prefix-less token (back-compat)", () => {
    // The people-only `<@uuid>` form is unchanged so old content + the
    // person-notification fan-out (chat/mentions.ts) keep working.
    expect(buildToken("user", "11111111-1111-1111-1111-111111111111")).toBe(
      "<@11111111-1111-1111-1111-111111111111>",
    );
  });

  it("serializes every other type as <@type:id>", () => {
    expect(buildToken("workItem", "abc123")).toBe("<@workItem:abc123>");
    expect(buildToken("project", "p1")).toBe("<@project:p1>");
    expect(buildToken("note", "n1")).toBe("<@note:n1>");
  });
});

describe("parseRefs", () => {
  it("returns [] for empty / token-less content", () => {
    expect(parseRefs("")).toEqual([]);
    expect(parseRefs("no tokens here @bob #123 a@b.com")).toEqual([]);
  });

  it("parses a legacy person token as a user ref, id preserved verbatim", () => {
    expect(parseRefs("hi <@AAAA-bbbb-CCCC>")).toEqual([
      { type: "user", id: "AAAA-bbbb-CCCC" },
    ]);
  });

  it("parses typed tokens to their declared type", () => {
    expect(parseRefs("see <@workItem:wi1> in <@project:pr1>")).toEqual([
      { type: "workItem", id: "wi1" },
      { type: "project", id: "pr1" },
    ]);
  });

  it("falls back to user for an unknown type prefix (never throws)", () => {
    expect(parseRefs("<@bogusType:xyz>")).toEqual([{ type: "user", id: "xyz" }]);
  });

  it("dedupes by (type, case-insensitive id), keeping first occurrence", () => {
    const got = parseRefs("<@workItem:AAA> then again <@workItem:aaa>");
    expect(got).toEqual([{ type: "workItem", id: "AAA" }]);
  });

  it("keeps distinct ids of the same type and same id across types", () => {
    const got = parseRefs("<@workItem:a> <@workItem:b> <@project:a>");
    expect(got).toEqual([
      { type: "workItem", id: "a" },
      { type: "workItem", id: "b" },
      { type: "project", id: "a" },
    ]);
  });

  it("round-trips every entity type through buildToken → parseRefs", () => {
    for (const type of ENTITY_TYPES) {
      const id = "id-123";
      expect(parseRefs(buildToken(type, id))).toEqual([{ type, id }]);
    }
  });
});

describe("TOKEN_RE", () => {
  it("is a fresh, stateless matcher (no lastIndex bleed between parses)", () => {
    // parseRefs builds its own RegExp from the source each call; assert the
    // exported source itself doesn't over-match plain prose.
    const re = new RegExp(TOKEN_RE.source, "g");
    expect("plain @handle text".match(re)).toBeNull();
    expect("<@u1> <@workItem:w1>".match(re)).toEqual(["<@u1>", "<@workItem:w1>"]);
  });
});

describe("refKey", () => {
  it("lowercases the id so hex UUIDs collapse regardless of case", () => {
    expect(refKey("user", "ABC")).toBe("user:abc");
    expect(refKey("workItem", "XyZ")).toBe("workItem:xyz");
  });
});

describe("isEntityType", () => {
  it("accepts known types and rejects everything else", () => {
    expect(isEntityType("user")).toBe(true);
    expect(isEntityType("workItem")).toBe(true);
    expect(isEntityType("nope")).toBe(false);
    expect(isEntityType(123)).toBe(false);
    expect(isEntityType(null)).toBe(false);
    expect(isEntityType(undefined)).toBe(false);
  });
});

describe("per-type metadata is complete (guards adding a type to ENTITY_TYPES)", () => {
  it("ENTITY_PREFIX covers exactly ENTITY_TYPES", () => {
    expect(sorted(Object.keys(ENTITY_PREFIX))).toEqual(sorted(ENTITY_TYPES));
  });

  it("ENTITY_LABEL covers exactly ENTITY_TYPES", () => {
    expect(sorted(Object.keys(ENTITY_LABEL))).toEqual(sorted(ENTITY_TYPES));
  });

  it("ENTITY_LABEL_PLURAL covers exactly ENTITY_TYPES", () => {
    expect(sorted(Object.keys(ENTITY_LABEL_PLURAL))).toEqual(sorted(ENTITY_TYPES));
  });

  it("ENTITY_ORDER is a permutation of ENTITY_TYPES with no dupes", () => {
    expect(ENTITY_ORDER.length).toBe(ENTITY_TYPES.length);
    expect(new Set(ENTITY_ORDER).size).toBe(ENTITY_ORDER.length);
    expect(sorted(ENTITY_ORDER as EntityType[])).toEqual(sorted(ENTITY_TYPES));
  });
});

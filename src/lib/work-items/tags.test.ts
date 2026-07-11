import { describe, expect, it } from "vitest";
import {
  MAX_TAGS,
  MAX_TAG_NAME_LEN,
  normalizeColor,
  normalizeTagName,
  readTagRegistry,
  removeTagDef,
  upsertTagDef,
  type TagDef,
} from "./tags";

describe("normalizeTagName", () => {
  it("trims, collapses internal whitespace, and caps length", () => {
    expect(normalizeTagName("  hello ")).toBe("hello");
    expect(normalizeTagName("a   b\tc")).toBe("a b c");
    expect(normalizeTagName("x".repeat(80))).toHaveLength(MAX_TAG_NAME_LEN);
  });

  it("returns '' for non-strings / empty input", () => {
    expect(normalizeTagName("")).toBe("");
    expect(normalizeTagName("   ")).toBe("");
    expect(normalizeTagName(null)).toBe("");
    expect(normalizeTagName(42)).toBe("");
  });
});

describe("normalizeColor", () => {
  it("accepts #rgb and #rrggbb, lowercased", () => {
    expect(normalizeColor("#FFF")).toBe("#fff");
    expect(normalizeColor("  #Ef4444 ")).toBe("#ef4444");
  });

  it("rejects anything that isn't a hex color → null (color is optional)", () => {
    expect(normalizeColor("red")).toBeNull();
    expect(normalizeColor("#12")).toBeNull();
    expect(normalizeColor("#12345")).toBeNull();
    expect(normalizeColor("")).toBeNull();
    expect(normalizeColor(null)).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
  });
});

describe("readTagRegistry", () => {
  it("returns [] for garbage / missing settings", () => {
    expect(readTagRegistry(null)).toEqual([]);
    expect(readTagRegistry(42)).toEqual([]);
    expect(readTagRegistry({})).toEqual([]);
    expect(readTagRegistry({ tags: "nope" })).toEqual([]);
  });

  it("normalizes rich entries and tolerates bare strings", () => {
    const out = readTagRegistry({
      tags: [
        { name: "Bug", color: "#EF4444" },
        { name: "  Feature ", color: "not-a-color" },
        "plain",
      ],
    });
    expect(out).toEqual([
      { name: "Bug", color: "#ef4444" },
      { name: "Feature", color: null },
      { name: "plain", color: null },
    ]);
  });

  it("de-duplicates by name case-insensitively (first wins) and drops empties", () => {
    const out = readTagRegistry({
      tags: [{ name: "Bug", color: "#111111" }, { name: "bug", color: "#222222" }, { name: "  " }],
    });
    expect(out).toEqual([{ name: "Bug", color: "#111111" }]);
  });

  it("caps the list at MAX_TAGS", () => {
    const many = Array.from({ length: MAX_TAGS + 25 }, (_, i) => ({ name: `t${i}` }));
    expect(readTagRegistry({ tags: many })).toHaveLength(MAX_TAGS);
  });
});

describe("upsertTagDef", () => {
  it("appends a new tag", () => {
    const next = upsertTagDef([], { name: "Bug", color: "#ef4444" });
    expect(next).toEqual([{ name: "Bug", color: "#ef4444" }]);
  });

  it("updates color + display case for an existing name (case-insensitive), in place", () => {
    const list: TagDef[] = [
      { name: "Bug", color: "#ef4444" },
      { name: "Chore", color: null },
    ];
    const next = upsertTagDef(list, { name: "bug", color: "#0000ff" });
    expect(next).toEqual([
      { name: "bug", color: "#0000ff" },
      { name: "Chore", color: null },
    ]);
    // input not mutated
    expect(list[0]).toEqual({ name: "Bug", color: "#ef4444" });
  });

  it("normalizes name + color, and is a no-op for an empty name", () => {
    expect(upsertTagDef([], { name: "  Spike  ", color: "#ABC" })).toEqual([
      { name: "Spike", color: "#abc" },
    ]);
    const list: TagDef[] = [{ name: "Bug", color: null }];
    expect(upsertTagDef(list, { name: "   ", color: "#fff" })).toBe(list);
  });
});

describe("removeTagDef", () => {
  it("removes by name case-insensitively and leaves the rest", () => {
    const list: TagDef[] = [
      { name: "Bug", color: null },
      { name: "Feature", color: null },
    ];
    expect(removeTagDef(list, "BUG")).toEqual([{ name: "Feature", color: null }]);
  });

  it("is a no-op when the name is absent or empty", () => {
    const list: TagDef[] = [{ name: "Bug", color: null }];
    expect(removeTagDef(list, "missing")).toEqual(list);
    expect(removeTagDef(list, "  ")).toBe(list);
  });
});

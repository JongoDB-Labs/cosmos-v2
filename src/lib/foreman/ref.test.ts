import { describe, it, expect } from "vitest";
import { buildRef, parseRef } from "./ref";

describe("buildRef", () => {
  it("builds simple refs like COSMOS-12", () => {
    expect(buildRef("COSMOS", 12)).toBe("COSMOS-12");
  });

  it("builds refs like VITL-3", () => {
    expect(buildRef("VITL", 3)).toBe("VITL-3");
  });

  it("builds refs with keys containing digits like A1-2", () => {
    expect(buildRef("A1", 2)).toBe("A1-2");
  });

  it("builds refs with single-digit numbers", () => {
    expect(buildRef("KEY", 1)).toBe("KEY-1");
  });

  it("builds refs with large numbers", () => {
    expect(buildRef("KEY", 999999)).toBe("KEY-999999");
  });
});

describe("parseRef", () => {
  it("parses COSMOS-12 into key=COSMOS, number=12", () => {
    expect(parseRef("COSMOS-12")).toEqual({ key: "COSMOS", number: 12 });
  });

  it("parses VITL-3 into key=VITL, number=3", () => {
    expect(parseRef("VITL-3")).toEqual({ key: "VITL", number: 3 });
  });

  it("parses A1-2 with key containing digits", () => {
    expect(parseRef("A1-2")).toEqual({ key: "A1", number: 2 });
  });

  it("returns null for string without trailing -number", () => {
    expect(parseRef("nope")).toBeNull();
  });

  it("returns null for COSMOS- without digits", () => {
    expect(parseRef("COSMOS-")).toBeNull();
  });

  it("splits on the last hyphen-number for COSMOS-12-3", () => {
    expect(parseRef("COSMOS-12-3")).toEqual({
      key: "COSMOS-12",
      number: 3,
    });
  });

  it("handles keys with multiple hyphens correctly", () => {
    expect(parseRef("MY-PROJECT-CODE-5")).toEqual({
      key: "MY-PROJECT-CODE",
      number: 5,
    });
  });

  it("returns null for empty string", () => {
    expect(parseRef("")).toBeNull();
  });

  it("returns null for string with only hyphen", () => {
    expect(parseRef("-")).toBeNull();
  });

  it("returns null for string with only digits", () => {
    expect(parseRef("123")).toBeNull();
  });

  it("returns null for string ending with non-digit after hyphen", () => {
    expect(parseRef("KEY-abc")).toBeNull();
  });
});

describe("round-trip: parseRef(buildRef(key, number))", () => {
  it("round-trips COSMOS and 12", () => {
    const built = buildRef("COSMOS", 12);
    const parsed = parseRef(built);
    expect(parsed).toEqual({ key: "COSMOS", number: 12 });
  });

  it("round-trips VITL and 3", () => {
    const built = buildRef("VITL", 3);
    const parsed = parseRef(built);
    expect(parsed).toEqual({ key: "VITL", number: 3 });
  });

  it("round-trips A1 and 2", () => {
    const built = buildRef("A1", 2);
    const parsed = parseRef(built);
    expect(parsed).toEqual({ key: "A1", number: 2 });
  });

  it("round-trips single-digit number", () => {
    const built = buildRef("KEY", 1);
    const parsed = parseRef(built);
    expect(parsed).toEqual({ key: "KEY", number: 1 });
  });

  it("round-trips large number", () => {
    const built = buildRef("PROJ", 123456);
    const parsed = parseRef(built);
    expect(parsed).toEqual({ key: "PROJ", number: 123456 });
  });
});

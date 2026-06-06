import { describe, it, expect } from "vitest";
import { slugify } from "../slugify";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with dashes", () => {
    expect(slugify("My Cool Template!")).toBe("my-cool-template");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    expect(slugify(long).length).toBe(50);
  });

  it("collapses consecutive dashes", () => {
    expect(slugify("a---b")).toBe("a-b");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles unicode", () => {
    expect(slugify("Café Résumé")).toBe("caf-r-sum");
  });
});

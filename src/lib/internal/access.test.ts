import { describe, expect, it } from "vitest";
import { isInternalAdmin } from "./access";

describe("isInternalAdmin", () => {
  it("returns false when env unset", () => {
    expect(isInternalAdmin("admin@example.com", undefined)).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isInternalAdmin("Admin@Example.com", "admin@example.com")).toBe(true);
  });

  it("accepts comma-separated list", () => {
    expect(isInternalAdmin("a@x.com", "b@x.com, a@x.com,c@x.com")).toBe(true);
  });

  it("rejects unknown emails", () => {
    expect(isInternalAdmin("nope@x.com", "a@x.com")).toBe(false);
  });
});

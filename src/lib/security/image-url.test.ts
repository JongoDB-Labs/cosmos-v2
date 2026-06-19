import { describe, it, expect } from "vitest";
import { imageUrlSchema, logoUrlSchema } from "./image-url";

// `imageUrlSchema` is the shared scheme allow-list behind org logos and user
// avatars. It must reject active-content URL schemes (which `z.string().url()`
// would accept) while allowing inline images and ordinary web URLs, and it
// must enforce a configurable size ceiling on inline data URLs.
describe("imageUrlSchema scheme allow-list", () => {
  const schema = imageUrlSchema(1000, "bad image url");

  it("rejects javascript: URLs", () => {
    expect(schema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("rejects data:text/html URLs", () => {
    expect(schema.safeParse("data:text/html,<script>alert(1)</script>").success).toBe(false);
  });

  it("accepts http and https URLs", () => {
    expect(schema.safeParse("https://example.com/a.png").success).toBe(true);
    expect(schema.safeParse("http://example.com/a.png").success).toBe(true);
  });

  it("accepts a data:image URL within the byte cap", () => {
    expect(schema.safeParse("data:image/png;base64,iVBORw0KGgo=").success).toBe(true);
  });

  it("rejects a data:image URL over the byte cap", () => {
    const oversized = "data:image/png;base64," + "A".repeat(1000);
    expect(schema.safeParse(oversized).success).toBe(false);
  });

  it("allows null and undefined (nullable + optional)", () => {
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});

describe("logoUrlSchema (org logo preset)", () => {
  it("rejects a javascript: logoUrl", () => {
    expect(logoUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("accepts an https logoUrl", () => {
    expect(logoUrlSchema.safeParse("https://cdn.example.com/logo.png").success).toBe(true);
  });

  it("enforces the ~280KB data:image ceiling", () => {
    expect(logoUrlSchema.safeParse("data:image/png;base64,iVBORw0KGgo=").success).toBe(true);
    const oversized = "data:image/png;base64," + "A".repeat(280_000);
    expect(logoUrlSchema.safeParse(oversized).success).toBe(false);
  });
});

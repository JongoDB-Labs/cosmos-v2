import { describe, it, expect } from "vitest";
import {
  imageUrlSchema,
  logoUrlSchema,
  avatarUrlSchema,
  MAX_AVATAR_DATAURL_BYTES,
  MAX_AVATAR_SOURCE_BYTES,
  MAX_AVATAR_SOURCE_MB,
} from "./image-url";

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

// The avatar preset shares the scheme allow-list but carries a much larger
// ceiling than the old ~200KB avatar cap, so photos that were formerly rejected
// (downscaled client-side to well under this cap) now save successfully.
describe("avatarUrlSchema (user avatar preset)", () => {
  it("rejects a javascript: avatarUrl", () => {
    expect(avatarUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("accepts an https avatarUrl", () => {
    expect(avatarUrlSchema.safeParse("https://cdn.example.com/me.png").success).toBe(true);
  });

  it("accepts a data:image URL well over the old 200KB avatar cap", () => {
    // A ~300KB data URL — larger than the historical 200KB/280KB limits that
    // rejected uploads, but comfortably under the new avatar ceiling.
    const bigButOk = "data:image/png;base64," + "A".repeat(300_000);
    expect(bigButOk.length).toBeGreaterThan(280_000);
    expect(avatarUrlSchema.safeParse(bigButOk).success).toBe(true);
  });

  it("rejects a data:image URL over the stored ceiling with a clear message", () => {
    const oversized = "data:image/png;base64," + "A".repeat(MAX_AVATAR_DATAURL_BYTES);
    const result = avatarUrlSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/too large|resized/i);
    }
  });

  it("allows null and undefined (clearing the avatar)", () => {
    expect(avatarUrlSchema.safeParse(null).success).toBe(true);
    expect(avatarUrlSchema.safeParse(undefined).success).toBe(true);
  });

  it("exposes a configurable, meaningfully-raised limit shared client/server", () => {
    // The stored ceiling must stay well above the old ~200KB cap so the feature
    // (accepting large photos) can't silently regress.
    expect(MAX_AVATAR_DATAURL_BYTES).toBeGreaterThan(280_000);
    expect(MAX_AVATAR_SOURCE_BYTES).toBeGreaterThan(MAX_AVATAR_DATAURL_BYTES);
    expect(MAX_AVATAR_SOURCE_MB).toBe(Math.round(MAX_AVATAR_SOURCE_BYTES / 1_000_000));
  });
});

import { describe, it, expect } from "vitest";
import { updateOrgSchema } from "./route";

// The general org-update route echoes `logoUrl` through the public,
// unauthenticated brand endpoint, so its write-side validation must reject
// active-content URL schemes (`javascript:`, `data:text/html`) the same way
// the theme route does. `z.string().url()` accepts those schemes; the strict
// validator must not.
describe("updateOrgSchema logoUrl validation", () => {
  it("rejects a javascript: logoUrl", () => {
    expect(updateOrgSchema.safeParse({ logoUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("rejects a data:text/html logoUrl", () => {
    expect(
      updateOrgSchema.safeParse({
        logoUrl: "data:text/html,<script>alert(1)</script>",
      }).success,
    ).toBe(false);
  });

  it("accepts an https logoUrl", () => {
    expect(
      updateOrgSchema.safeParse({ logoUrl: "https://cdn.example.com/logo.png" }).success,
    ).toBe(true);
  });

  it("accepts a data:image logoUrl", () => {
    expect(
      updateOrgSchema.safeParse({
        logoUrl: "data:image/png;base64,iVBORw0KGgo=",
      }).success,
    ).toBe(true);
  });

  it("accepts null (clearing the logo)", () => {
    expect(updateOrgSchema.safeParse({ logoUrl: null }).success).toBe(true);
  });
});

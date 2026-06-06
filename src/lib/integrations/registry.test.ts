import { describe, it, expect } from "vitest";
import { IntegrationRegistry, INTEGRATION_CATEGORIES } from "./registry";
import "./registry/index"; // triggers registration

describe("integration registry integrity", () => {
  const all = IntegrationRegistry.getAll();

  it("has providers registered", () => {
    expect(all.length).toBeGreaterThan(120);
  });

  it("every slug is unique", () => {
    const slugs = all.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every provider has a valid category", () => {
    for (const p of all) {
      expect(INTEGRATION_CATEGORIES).toContain(p.category);
    }
  });

  it("every provider has valid status + connect, and coming_soon is never connectable", () => {
    for (const p of all) {
      expect(["available", "coming_soon"]).toContain(p.status);
      expect(["google", "config", "none"]).toContain(p.connect);
      if (p.status === "coming_soon") expect(p.connect).toBe("none");
      if (p.connect !== "none") expect(p.status).toBe("available");
    }
  });

  it("every provider has non-empty name + description", () => {
    for (const p of all) {
      expect(p.name.trim().length).toBeGreaterThan(0);
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });
});

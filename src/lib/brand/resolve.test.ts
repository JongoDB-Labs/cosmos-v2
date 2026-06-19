import { afterEach, describe, expect, it } from "vitest";
import { resolveBrand, pickOrgBrand, type OrgBrandOverrides } from "./resolve";

const original = process.env.NEXT_PUBLIC_PRODUCT;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = original;
});

describe("resolveBrand", () => {
  it("returns the deployment default unchanged when org is null/undefined", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    expect(resolveBrand(null).name).toBe("COSMOS");
    expect(resolveBrand(undefined).name).toBe("COSMOS");
    expect(resolveBrand({}).name).toBe("COSMOS");
  });

  it("overlays each non-null org field onto the base profile", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const org: OrgBrandOverrides = {
      brandName: "Acme Studio",
      logoUrl: "https://cdn.example/acme.png",
      agentName: "Acme Helper",
      tagline: "Build beautifully",
      wakeWord: "Hey Acme",
      defaultSkinId: "atelier",
    };
    const b = resolveBrand(org);
    expect(b.name).toBe("Acme Studio");
    expect(b.title).toBe("Acme Studio");
    expect(b.tagline).toBe("Build beautifully");
    expect(b.markSrc).toBe("https://cdn.example/acme.png");
    expect(b.agentName).toBe("Acme Helper");
    expect(b.wakeWord).toBe("Hey Acme");
    expect(b.defaultSkinId).toBe("atelier");
  });

  it("falls through to the base profile for null fields", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = resolveBrand({ brandName: "Acme Studio" });
    expect(b.name).toBe("Acme Studio");
    expect(b.tagline).toBe("Enterprise Project Management"); // base
    expect(b.markSrc).toBe("/cosmos-mark.png"); // base
    expect(b.agentName).toBe("COSMOS Agent"); // base
    expect(b.wakeWord).toBe("Hey COSMOS"); // base
    expect(b.defaultSkinId).toBe("universe"); // base
  });

  it("does not mutate or override non-brand profile fields (themeColor, key)", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = resolveBrand({ brandName: "Acme Studio" });
    expect(b.key).toBe("cosmos");
    expect(b.themeColor).toBe("#0B0E1A");
    expect(b.signingMode).toBe("kms");
  });

  it("resolves against the active product (Pontis) base", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "pontis";
    expect(resolveBrand(null).name).toBe("Pontis");
    expect(resolveBrand({ brandName: "ĒSO" }).name).toBe("ĒSO");
    expect(resolveBrand({}).defaultSkinId).toBe("atelier"); // Pontis base
  });
});

describe("pickOrgBrand", () => {
  it("keeps only the six branding keys from a wider org row", () => {
    const row = {
      id: "o1",
      name: "Acme Inc",
      slug: "acme",
      brandName: "Acme Studio",
      logoUrl: "https://cdn/x.png",
      agentName: null,
      tagline: "T",
      wakeWord: null,
      defaultSkinId: "atelier",
      themePrimary: "#123456",
      settings: {},
    };
    expect(pickOrgBrand(row)).toEqual({
      brandName: "Acme Studio",
      logoUrl: "https://cdn/x.png",
      agentName: null,
      tagline: "T",
      wakeWord: null,
      defaultSkinId: "atelier",
    });
  });

  it("returns null for a null/undefined row", () => {
    expect(pickOrgBrand(null)).toBeNull();
    expect(pickOrgBrand(undefined)).toBeNull();
  });
});

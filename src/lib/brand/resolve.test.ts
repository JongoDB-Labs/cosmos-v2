import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveBrand, pickOrgBrand, type OrgBrandOverrides } from "./resolve";
import { registerProductProfile, type ProductProfile } from "@/lib/product/profiles";

// A synthetic non-cosmos brand registered the way a composed brand plugin would,
// so we can assert resolveBrand overlays onto a NON-cosmos active product base
// without naming any real client/vertical.
const ACME_PROFILE: ProductProfile = {
  key: "acme",
  name: "Acme",
  title: "Acme",
  description: "An example vertical brand, used only in tests.",
  tagline: "Example Vertical",
  markSrc: "/acme-mark.png",
  themeColor: "#f9f7f4",
  backgroundColor: "#f9f7f4",
  agentName: "Acme Agent",
  wakePhrase: "hey acme",
  wakeWord: "Hey Acme",
  defaultTenantClass: "COMMERCIAL",
  signingMode: "keyless",
  defaultEnabledModules: null,
  defaultEnabledSectors: ["aec"],
  defaultSkinId: "atelier",
  defaultEnabledPlugins: ["acme"],
};

const originalPublic = process.env.NEXT_PUBLIC_PRODUCT;
const originalServer = process.env.PRODUCT;
beforeAll(() => {
  registerProductProfile(ACME_PROFILE);
});
beforeEach(() => {
  // The runtime PRODUCT env takes precedence in getBrand(); clear it so each
  // case controls the product purely via NEXT_PUBLIC_PRODUCT as it intends.
  delete process.env.PRODUCT;
});
afterEach(() => {
  if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = originalPublic;
  if (originalServer === undefined) delete process.env.PRODUCT;
  else process.env.PRODUCT = originalServer;
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
    expect(b.wakePhrase).toBe("hey acme"); // derived from wakeWord
    expect(b.defaultSkinId).toBe("atelier");
  });

  it("derives wakePhrase from org.wakeWord when provided", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = resolveBrand({ wakeWord: "Hey Acme" });
    expect(b.wakePhrase).toBe("hey acme");
  });

  it("keeps base wakePhrase when org provides no wakeWord", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = resolveBrand({ brandName: "Acme Studio" });
    expect(b.wakePhrase).toBe("hey cosmo"); // base
  });

  it("falls through to the base profile for null fields", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = resolveBrand({ brandName: "Acme Studio" });
    expect(b.name).toBe("Acme Studio");
    expect(b.tagline).toBe("Enterprise Project Management"); // base
    expect(b.markSrc).toBe("/cosmos-mark.png"); // base
    expect(b.agentName).toBe("COSMOS Agent"); // base
    expect(b.wakeWord).toBe("Hey Cosmo"); // base
    expect(b.defaultSkinId).toBe("universe"); // base
  });

  it("does not mutate or override non-brand profile fields (themeColor, key)", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = resolveBrand({ brandName: "Acme Studio" });
    expect(b.key).toBe("cosmos");
    expect(b.themeColor).toBe("#0B0E1A");
    expect(b.signingMode).toBe("kms");
  });

  it("resolves against the active (registered non-cosmos) product base", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "acme";
    expect(resolveBrand(null).name).toBe("Acme");
    expect(resolveBrand({ brandName: "Custom Co" }).name).toBe("Custom Co");
    expect(resolveBrand({}).defaultSkinId).toBe("atelier"); // acme base
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

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getBrand, registerProductProfile } from "@/lib/brand";
import type { ProductProfile } from "@/lib/product/profiles";

const originalPublic = process.env.NEXT_PUBLIC_PRODUCT;
const originalServer = process.env.PRODUCT;

// A synthetic non-cosmos brand, registered the way a composed brand plugin
// registers its own profile — lets us exercise product selection and the
// registry fallback without referencing any real client/vertical name.
const ACME_PROFILE: ProductProfile = {
  key: "acme",
  name: "Acme",
  title: "Acme — one interface for your practice",
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

beforeAll(() => {
  registerProductProfile(ACME_PROFILE);
});

afterEach(() => {
  if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = originalPublic;
  if (originalServer === undefined) delete process.env.PRODUCT;
  else process.env.PRODUCT = originalServer;
});

describe("getBrand", () => {
  it("defaults to the COSMOS profile", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    delete process.env.PRODUCT;
    const b = getBrand();
    expect(b.key).toBe("cosmos");
    expect(b.name).toBe("COSMOS");
    expect(b.themeColor).toBe("#0B0E1A");
    expect(b.defaultTenantClass).toBe("GOV");
  });

  it("selects a registered non-cosmos profile when PRODUCT matches it", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "acme";
    const b = getBrand();
    expect(b.key).toBe("acme");
    expect(b.name).toBe("Acme");
    expect(b.themeColor).toBe("#f9f7f4");
    expect(b.defaultTenantClass).toBe("COMMERCIAL");
  });

  it("falls back to COSMOS for an unknown PRODUCT", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "nope";
    expect(getBrand().key).toBe("cosmos");
  });

  it("COSMOS enables all modules + sectors by default (null = all)", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = getBrand();
    expect(b.defaultEnabledModules).toBeNull();
    expect(b.defaultEnabledSectors).toBeNull();
  });

  it("a registered vertical can scope its default sectors, all modules on", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "acme";
    const b = getBrand();
    expect(b.defaultEnabledModules).toBeNull();
    expect(b.defaultEnabledSectors).toEqual(["aec"]);
  });

  it("COSMOS uses the universe skin by default", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = getBrand();
    expect(b.defaultSkinId).toBe("universe");
  });

  it("a registered vertical can set its own default skin", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "acme";
    const b = getBrand();
    expect(b.defaultSkinId).toBe("atelier");
  });
});

describe("getBrand — runtime PRODUCT (Phase 3 one-image)", () => {
  it("prefers the server-runtime PRODUCT over the baked NEXT_PUBLIC_PRODUCT", () => {
    process.env.PRODUCT = "acme";
    process.env.NEXT_PUBLIC_PRODUCT = "cosmos"; // the baked client default
    expect(getBrand().key).toBe("acme");
  });

  it("honors PRODUCT even when NEXT_PUBLIC_PRODUCT is unset (one-image server render)", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    process.env.PRODUCT = "acme";
    expect(getBrand().key).toBe("acme");
  });

  it("falls back to NEXT_PUBLIC_PRODUCT when PRODUCT is unset (client bundle)", () => {
    delete process.env.PRODUCT;
    process.env.NEXT_PUBLIC_PRODUCT = "acme";
    expect(getBrand().key).toBe("acme");
  });

  it("an unknown PRODUCT validates against the registry → cosmos", () => {
    process.env.PRODUCT = "not_a_product";
    delete process.env.NEXT_PUBLIC_PRODUCT;
    expect(getBrand().key).toBe("cosmos");
  });

  it("rejects inherited Object.prototype keys as PRODUCT → cosmos", () => {
    // bare `in` would match `constructor`/`toString`/`__proto__` etc.
    process.env.PRODUCT = "constructor";
    delete process.env.NEXT_PUBLIC_PRODUCT;
    expect(getBrand().key).toBe("cosmos");
  });

  it("defaults to cosmos when neither env is set", () => {
    delete process.env.PRODUCT;
    delete process.env.NEXT_PUBLIC_PRODUCT;
    expect(getBrand().key).toBe("cosmos");
  });
});

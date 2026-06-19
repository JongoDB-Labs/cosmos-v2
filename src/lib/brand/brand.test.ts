import { afterEach, describe, expect, it } from "vitest";
import { getBrand } from "@/lib/brand";

const originalPublic = process.env.NEXT_PUBLIC_PRODUCT;
const originalServer = process.env.PRODUCT;
afterEach(() => {
  if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = originalPublic;
  if (originalServer === undefined) delete process.env.PRODUCT;
  else process.env.PRODUCT = originalServer;
});

describe("getBrand", () => {
  it("defaults to the COSMOS profile", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = getBrand();
    expect(b.key).toBe("cosmos");
    expect(b.name).toBe("COSMOS");
    expect(b.themeColor).toBe("#0B0E1A");
    expect(b.defaultTenantClass).toBe("GOV");
  });

  it("selects the Pontis profile when PRODUCT=pontis", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "pontis";
    const b = getBrand();
    expect(b.key).toBe("pontis");
    expect(b.name).toBe("Pontis");
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

  it("Pontis defaults to the AEC sector only, all modules on", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "pontis";
    const b = getBrand();
    expect(b.defaultEnabledModules).toBeNull();
    expect(b.defaultEnabledSectors).toEqual(["aec"]);
  });

  it("COSMOS uses the universe skin by default", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const b = getBrand();
    expect(b.defaultSkinId).toBe("universe");
  });

  it("Pontis uses the atelier skin by default", () => {
    process.env.NEXT_PUBLIC_PRODUCT = "pontis";
    const b = getBrand();
    expect(b.defaultSkinId).toBe("atelier");
  });
});

describe("getBrand — runtime PRODUCT (Phase 3 one-image)", () => {
  it("prefers the server-runtime PRODUCT over the baked NEXT_PUBLIC_PRODUCT", () => {
    process.env.PRODUCT = "pontis";
    process.env.NEXT_PUBLIC_PRODUCT = "cosmos"; // the baked client default
    expect(getBrand().key).toBe("pontis");
  });

  it("honors PRODUCT even when NEXT_PUBLIC_PRODUCT is unset (one-image server render)", () => {
    delete process.env.NEXT_PUBLIC_PRODUCT;
    process.env.PRODUCT = "pontis";
    expect(getBrand().key).toBe("pontis");
  });

  it("falls back to NEXT_PUBLIC_PRODUCT when PRODUCT is unset (client bundle)", () => {
    delete process.env.PRODUCT;
    process.env.NEXT_PUBLIC_PRODUCT = "pontis";
    expect(getBrand().key).toBe("pontis");
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

import { afterEach, describe, expect, it } from "vitest";
import { getBrand } from "@/lib/brand";

const original = process.env.NEXT_PUBLIC_PRODUCT;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = original;
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
});

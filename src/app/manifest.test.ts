import { afterEach, expect, it } from "vitest";
import manifest from "./manifest";

const original = process.env.NEXT_PUBLIC_PRODUCT;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = original;
});

it("uses the COSMOS brand by default", () => {
  delete process.env.NEXT_PUBLIC_PRODUCT;
  const m = manifest();
  expect(m.name).toBe("COSMOS");
  expect(m.theme_color).toBe("#0B0E1A");
  expect(m.icons?.[0]?.src).toBe("/cosmos-mark.png");
});

it("switches to the Pontis brand when PRODUCT=pontis", () => {
  process.env.NEXT_PUBLIC_PRODUCT = "pontis";
  const m = manifest();
  expect(m.name).toBe("Pontis");
  expect(m.theme_color).toBe("#f9f7f4");
  expect(m.icons?.[0]?.src).toBe("/pontis-mark.png");
});

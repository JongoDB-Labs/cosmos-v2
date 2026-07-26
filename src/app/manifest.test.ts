import { afterEach, beforeAll, expect, it } from "vitest";
import manifest from "./manifest";
import { registerProductProfile, type ProductProfile } from "@/lib/product/profiles";

// A synthetic non-cosmos brand, registered the way a composed brand plugin
// registers its own — exercises PRODUCT-driven manifest branding without naming
// any real client/vertical.
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

beforeAll(() => {
  registerProductProfile(ACME_PROFILE);
});

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

it("switches to a registered vertical brand when PRODUCT matches it", () => {
  process.env.NEXT_PUBLIC_PRODUCT = "acme";
  const m = manifest();
  expect(m.name).toBe("Acme");
  expect(m.theme_color).toBe("#f9f7f4");
  expect(m.icons?.[0]?.src).toBe("/acme-mark.png");
});

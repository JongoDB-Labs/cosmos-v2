// @vitest-environment node
//
// RootBrandProvider is an ASYNC server component that calls connection() (to
// defer to request time) then seeds <BrandProvider> with the runtime brand.
// We mock next/server's connection() to a resolved no-op and render the element
// to a string, asserting the seeded brand name reaches a useBrand() consumer.
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerProductProfile, type ProductProfile } from "@/lib/product/profiles";

vi.mock("next/server", () => ({ connection: vi.fn().mockResolvedValue(undefined) }));

import { RootBrandProvider } from "./root-brand-provider";
import { useBrand } from "./brand-provider";

// A synthetic non-cosmos brand registered the way a composed brand plugin would,
// so we can assert a non-cosmos PRODUCT is seeded to descendants without naming
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

const originalServer = process.env.PRODUCT;
const originalPublic = process.env.NEXT_PUBLIC_PRODUCT;
beforeAll(() => {
  registerProductProfile(ACME_PROFILE);
});
afterEach(() => {
  if (originalServer === undefined) delete process.env.PRODUCT;
  else process.env.PRODUCT = originalServer;
  if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_PRODUCT;
  else process.env.NEXT_PUBLIC_PRODUCT = originalPublic;
});

function Probe() {
  return <span>{useBrand().name}</span>;
}

describe("RootBrandProvider", () => {
  it("seeds the runtime product brand (a registered non-cosmos PRODUCT) to descendants", async () => {
    process.env.PRODUCT = "acme";
    delete process.env.NEXT_PUBLIC_PRODUCT;
    // Await the async server component to get its rendered element tree.
    const tree = await RootBrandProvider({ children: <Probe /> });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Acme");
  });

  it("seeds the cosmos brand when PRODUCT is unset", async () => {
    delete process.env.PRODUCT;
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const tree = await RootBrandProvider({ children: <Probe /> });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("COSMOS");
  });
});

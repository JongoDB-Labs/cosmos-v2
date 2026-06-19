// @vitest-environment node
//
// RootBrandProvider is an ASYNC server component that calls connection() (to
// defer to request time) then seeds <BrandProvider> with the runtime brand.
// We mock next/server's connection() to a resolved no-op and render the element
// to a string, asserting the seeded brand name reaches a useBrand() consumer.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/server", () => ({ connection: vi.fn().mockResolvedValue(undefined) }));

import { RootBrandProvider } from "./root-brand-provider";
import { useBrand } from "./brand-provider";

const originalServer = process.env.PRODUCT;
const originalPublic = process.env.NEXT_PUBLIC_PRODUCT;
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
  it("seeds the runtime product brand (PRODUCT=pontis) to descendants", async () => {
    process.env.PRODUCT = "pontis";
    delete process.env.NEXT_PUBLIC_PRODUCT;
    // Await the async server component to get its rendered element tree.
    const tree = await RootBrandProvider({ children: <Probe /> });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Pontis");
  });

  it("seeds the cosmos brand when PRODUCT is unset", async () => {
    delete process.env.PRODUCT;
    delete process.env.NEXT_PUBLIC_PRODUCT;
    const tree = await RootBrandProvider({ children: <Probe /> });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("COSMOS");
  });
});

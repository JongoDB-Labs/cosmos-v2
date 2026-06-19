import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BrandProvider, useBrand } from "./brand-provider";
import { getBrand } from "@/lib/brand";

afterEach(cleanup);

function Probe() {
  const brand = useBrand();
  return <span data-testid="name">{brand.name}</span>;
}

describe("BrandProvider / useBrand", () => {
  it("provides the seeded brand to descendants", () => {
    const seed = { ...getBrand(), name: "Acme Studio", agentName: "Acme Helper" };
    render(
      <BrandProvider value={seed}>
        <Probe />
      </BrandProvider>,
    );
    expect(screen.getByTestId("name").textContent).toBe("Acme Studio");
  });

  it("falls back to getBrand() when there is no provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("name").textContent).toBe(getBrand().name);
  });
});

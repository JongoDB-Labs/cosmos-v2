import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CosmoAvatar } from "./cosmo-avatar";

afterEach(cleanup);

describe("CosmoAvatar", () => {
  it("renders a strict-circle avatar with theme-token-driven colors", () => {
    const { container } = render(<CosmoAvatar size={64} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Cosmo");
    expect(svg.getAttribute("width")).toBe("64");
    // theme adaptivity: the sky derives from the live tokens via color-mix
    expect(svg.getAttribute("style")).toContain("var(--primary)");
    expect(svg.getAttribute("style")).toContain("var(--surface)");
    // everything is clipped to the circle
    expect(container.querySelector("clipPath circle")).not.toBeNull();
    // accent-driven details reference the token directly
    expect(container.innerHTML).toContain('fill="var(--primary)"');
  });

  it("two instances coexist — gradient ids never collide", () => {
    const { container } = render(
      <div>
        <CosmoAvatar size={24} />
        <CosmoAvatar size={24} />
      </div>,
    );
    const ids = [...container.querySelectorAll("radialGradient, linearGradient, clipPath, filter")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });
});

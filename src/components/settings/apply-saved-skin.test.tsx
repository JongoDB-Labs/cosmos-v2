// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ApplySavedSkin } from "./apply-saved-skin";

function clearCookies() {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; max-age=0; path=/`;
  }
}

beforeEach(() => {
  clearCookies();
  document.documentElement.className = "skin-universe";
});
afterEach(cleanup);

describe("ApplySavedSkin precedence", () => {
  it("seeds the USER skin when present (no cookie)", () => {
    render(<ApplySavedSkin skinId="atelier" orgDefaultSkinId="universe" />);
    expect(document.documentElement.classList.contains("skin-atelier")).toBe(true);
    expect(document.cookie).toMatch(/skin=atelier/);
  });

  it("seeds the ORG default when the user has no skin", () => {
    render(<ApplySavedSkin skinId={null} orgDefaultSkinId="atelier" />);
    expect(document.documentElement.classList.contains("skin-atelier")).toBe(true);
    expect(document.cookie).toMatch(/skin=atelier/);
  });

  it("does nothing when neither user nor org skin is set", () => {
    render(<ApplySavedSkin skinId={null} orgDefaultSkinId={null} />);
    expect(document.documentElement.className).toBe("skin-universe");
    expect(document.cookie).not.toMatch(/skin=/);
  });

  it("an existing cookie wins over both user and org", () => {
    document.cookie = "skin=universe; path=/";
    render(<ApplySavedSkin skinId="atelier" orgDefaultSkinId="atelier" />);
    // class untouched (effect early-returns); cookie stays universe
    expect(document.cookie).toMatch(/skin=universe/);
    expect(document.cookie).not.toMatch(/skin=atelier/);
  });
});

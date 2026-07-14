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

  // Reproduces the reported bug: a browser previously used by another account
  // still carries that account's `skin` cookie. The logged-in user's own
  // resolution (personal pref, else org default) must win over that stale
  // cross-user cookie — never the other way around.
  it("the user's own skin wins over a stale cross-user cookie", () => {
    document.cookie = "skin=atelier; path=/"; // left behind by a PREVIOUS user
    render(<ApplySavedSkin skinId="ledger" orgDefaultSkinId="atelier" />);
    expect(document.documentElement.classList.contains("skin-ledger")).toBe(true);
    expect(document.cookie).toMatch(/skin=ledger/);
    expect(document.cookie).not.toMatch(/skin=atelier/);
  });

  it("the org default wins over a stale cross-user cookie when the user has no personal skin", () => {
    // The exact reported scenario: org owner set the org default to "universe";
    // a newly-invited user (no personal skinId yet) signs in on a browser that
    // still holds a previous user's "atelier" cookie.
    document.cookie = "skin=atelier; path=/";
    render(<ApplySavedSkin skinId={null} orgDefaultSkinId="universe" />);
    expect(document.documentElement.classList.contains("skin-universe")).toBe(true);
    expect(document.cookie).toMatch(/skin=universe/);
    expect(document.cookie).not.toMatch(/skin=atelier/);
  });
});

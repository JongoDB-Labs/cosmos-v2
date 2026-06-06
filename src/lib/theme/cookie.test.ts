import { describe, expect, it } from "vitest";
import { THEME_COOKIE, isValidThemeMode, type ThemeMode } from "./cookie";

describe("theme cookie", () => {
  it("cookie name is 'theme'", () => {
    expect(THEME_COOKIE).toBe("theme");
  });

  it("accepts 'dark' as valid", () => {
    expect(isValidThemeMode("dark")).toBe(true);
  });

  it("accepts 'light' as valid", () => {
    expect(isValidThemeMode("light")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidThemeMode("auto")).toBe(false);
    expect(isValidThemeMode("")).toBe(false);
    expect(isValidThemeMode(undefined)).toBe(false);
  });
});

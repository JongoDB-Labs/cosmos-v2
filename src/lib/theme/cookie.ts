export const THEME_COOKIE = "theme";

export type ThemeMode = "dark" | "light";

export function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

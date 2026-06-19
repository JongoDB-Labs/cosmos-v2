export const THEME_COOKIE = "theme";

export type ThemeMode = "dark" | "light";

export function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

import { SKIN_PRESETS } from "./skins";

export const SKIN_COOKIE = "skin";

export function isValidSkinId(id: unknown): id is string {
  return typeof id === "string" && SKIN_PRESETS.some((p) => p.id === id);
}

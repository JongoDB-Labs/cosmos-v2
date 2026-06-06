import { deriveHover, deriveTint, themedPrimary } from "./derive";

export function orgThemeCss(themePrimary: string | null | undefined): string {
  if (!themePrimary) return "";
  // Per-theme so the org colour is AA-legible both as a button background and
  // as link/accent text: darkened for light surfaces, lightened for dark.
  // Mirrors the base token structure in globals.css (base/.light vs
  // .dark/system-dark).
  const { light, dark } = themedPrimary(themePrimary);
  const rule = (sel: string, p: { primary: string; foreground: string }) =>
    `${sel} { --primary: ${p.primary}; --primary-hover: ${deriveHover(p.primary)}; --primary-tint: ${deriveTint(p.primary)}; --primary-foreground: ${p.foreground}; }`;
  return [
    rule(":root, :root.light", light),
    rule(":root.dark", dark),
    `@media (prefers-color-scheme: dark) { ${rule(":root:not(.light)", dark)} }`,
  ].join(" ");
}

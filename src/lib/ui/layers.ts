/**
 * The app's stacking scale for viewport-fixed UI, in one place.
 *
 * | Layer      | z   | Who                                                        |
 * |------------|-----|------------------------------------------------------------|
 * | in-page    | ≤30 | sticky headers, in-page popups (unchanged, not listed here) |
 * | mobileNav  | 30  | the phone bottom nav                                       |
 * | takeover   | 35  | full-screen views: timeline fullscreen, ceremony Present   |
 * | pageFloat  | 40  | fixed page bars, e.g. the Preferences save bar             |
 * | assistant  | 45  | docked side drawer, its corner button, its minimized tab   |
 * | overlay    | 50  | portaled dialogs, sheets, menus, popovers, tooltips        |
 * | tour       | 85+ | product tour (unchanged)                                   |
 * | skip link  | 100 | "Skip to content" (unchanged)                              |
 * | toasts     | —   | Sonner's own (above everything; moved sideways instead)    |
 *
 * The assistant layer sits BELOW overlays on purpose: a modal dialog makes
 * the page inert, so a panel above its backdrop could not be typed into, and
 * the drawer's own menus are portaled at the overlay layer and must open
 * above it. `layers.arch.test.ts` pins the order and that the portaled
 * primitives in `src/components/ui/` still say `z-50`.
 *
 * Tailwind only generates classes it can see as literal strings, so each
 * layer is exported as a literal class next to its number.
 */
export const LAYER = {
  mobileNav: 30,
  takeover: 35,
  pageFloat: 40,
  assistant: 45,
  overlay: 50,
} as const;

export const Z_MOBILE_NAV = "z-30";
export const Z_TAKEOVER = "z-[35]";
export const Z_PAGE_FLOAT = "z-40";
export const Z_ASSISTANT = "z-[45]";

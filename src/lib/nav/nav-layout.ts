/**
 * The org's sidebar layout, read out of the free-form `Organization.settings`
 * JSON blob.
 *
 * That column is untyped and written by several features, so anything read from
 * it has to survive whatever is actually in there — a half-written value, a
 * string where an array belongs, a null. The sidebar is not a place to throw:
 * a malformed setting must degrade to "hide nothing" rather than take the
 * navigation down with it, because an admin who cannot navigate cannot reach
 * the screen that would fix the setting.
 */
export interface NavLayout {
  order?: string[];
  hidden?: string[];
}

/** Only the FIXED anchors are unhideable — without them there is no way back. */
export const UNHIDEABLE_NAV_IDS = ["overview", "settings"] as const;

const stringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export function readNavLayout(settings: unknown): NavLayout | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const raw = (settings as Record<string, unknown>).navLayout;
  if (typeof raw !== "object" || raw === null) return undefined;

  const order = stringArray((raw as Record<string, unknown>).order);
  // Settings can never hide the way back to Settings. Enforced on READ as well
  // as on write, so a value written before this rule existed -- or edited
  // straight into the database -- still cannot strand anybody.
  const hidden = stringArray((raw as Record<string, unknown>).hidden)?.filter(
    (id) => !(UNHIDEABLE_NAV_IDS as readonly string[]).includes(id),
  );

  if (!order && (!hidden || hidden.length === 0)) return undefined;
  return { ...(order ? { order } : {}), ...(hidden?.length ? { hidden } : {}) };
}

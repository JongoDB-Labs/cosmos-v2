/**
 * Which links a dashboard's Link List may hold — ONE rule, run where a link is
 * drawn (`widgetLinks`, in the viewer's browser) and where a layout is saved
 * (`widgetLinkProblems`, in the board and personal-layout routes), so a link
 * the page would refuse to draw can never be stored by writing to the API
 * directly.
 *
 * The text is typed by one person onto a board everyone on the project opens,
 * so it is treated as hostile:
 *
 * - **External** links must be `http:` or `https:` with no user name or
 *   password in them. `javascript:` and `data:` would run in every viewer's
 *   session on click. They open in a new tab with no opener and no referrer
 *   (the widget's job).
 * - **In-app** links are paths. `startsWith("/") && !startsWith("//")` is NOT
 *   enough: a browser reads `/\evil.example` as `//evil.example` — another
 *   site — and strips a tab or newline out of `/\t/evil.example` to the same
 *   effect. So a target holding a backslash, any whitespace or any control
 *   character is refused outright, and what is left is resolved against the
 *   app's own origin and must still BE that origin. What gets drawn is the
 *   normalised `pathname + search + hash`, never the typed text.
 *
 * Pure, and safe on both sides of the wire.
 */

export type WidgetLinkCheck =
  | { ok: true; href: string; external: boolean }
  | { ok: false; reason: string };

/**
 * The origin in-app paths are resolved against when the caller has none (the
 * server, or a render before `window` exists). Whether a PATH stays on its
 * origin does not depend on which origin that is, so the browser — which
 * passes `location.origin` — and the server reach the same verdict and the
 * same `href`.
 */
const FALLBACK_ORIGIN = "https://app.invalid";

/** A backslash, whitespace of any kind, or a C0/C1 control character. */
function hasUnsafeCharacter(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
    if (ch === "\\" || /\s/u.test(ch)) return true;
  }
  return false;
}

function originOf(candidate: string | undefined): string {
  if (candidate) {
    try {
      const o = new URL(candidate).origin;
      if (o !== "null") return o;
    } catch {
      // fall through to the fallback
    }
  }
  return FALLBACK_ORIGIN;
}

/** Is `target` a link a Link List may hold, and if so what exactly to draw. */
export function checkWidgetLinkTarget(target: string, origin?: string): WidgetLinkCheck {
  if (target.length === 0) return { ok: false, reason: "has no link" };
  if (hasUnsafeCharacter(target)) {
    return { ok: false, reason: "contains a backslash, a space or a control character" };
  }

  if (target.startsWith("/")) {
    if (target.startsWith("//")) {
      return { ok: false, reason: "starts with // and would leave the app" };
    }
    const base = originOf(origin);
    let url: URL;
    try {
      url = new URL(target, base);
    } catch {
      return { ok: false, reason: "is not a valid path" };
    }
    if (url.origin !== base || !url.pathname.startsWith("/")) {
      return { ok: false, reason: "would leave the app" };
    }
    return { ok: true, href: `${url.pathname}${url.search}${url.hash}`, external: false };
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, reason: "is not an http(s) link or an in-app path starting with /" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "is not an http or https link" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "has a user name or password in it" };
  }
  return { ok: true, href: url.toString(), external: true };
}

/** One non-empty line of a Link List's `Label|URL` text. */
export interface WidgetLinkLine {
  /** 1-based, counting blank lines, so it matches what the author sees. */
  line: number;
  label: string;
  target: string;
}

/** The `Label|URL` lines; a line with no `|` is a bare URL labelled with itself. */
export function widgetLinkLines(raw: string): WidgetLinkLine[] {
  const out: WidgetLinkLine[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const bar = trimmed.indexOf("|");
    const label = (bar === -1 ? trimmed : trimmed.slice(0, bar)).trim();
    const target = (bar === -1 ? trimmed : trimmed.slice(bar + 1)).trim();
    out.push({ line: i + 1, label: label.length > 0 ? label : target, target });
  });
  return out;
}

/**
 * The `detail` of the 400 that refuses a layout: the first problem, and how
 * many more. Short on purpose — the builder shows it in a toast, and a toast
 * listing every bad line grew over the Save button (driven on localhost). The
 * routes put the full list in the problem's `issues`.
 */
export function widgetLinkRefusal(problems: readonly string[]): string {
  const more = problems.length - 1;
  const tail = more === 1 ? " 1 more link has a problem too." : more > 1 ? ` ${more} more links have a problem too.` : "";
  return `A link can't be saved. ${problems[0] ?? ""}${tail}`;
}

/** The most links one list draws. */
export const MAX_WIDGET_LINKS = 50;

/**
 * Every problem with the links in a set of saved widgets, as sentences a person
 * can act on; empty when all of them may be stored. The save routes refuse a
 * layout with any (400), so the renderer's filter is a second line, not the
 * only one.
 *
 * `widgets` is whatever the request carried — this runs before anything else
 * trusts its shape — so anything that is not a widget with a `config` is
 * skipped here and left to the routes' own validation.
 */
export function widgetLinkProblems(widgets: unknown): string[] {
  if (!Array.isArray(widgets)) return [];
  const problems: string[] = [];
  for (const w of widgets) {
    if (!w || typeof w !== "object") continue;
    const config = (w as { config?: unknown }).config;
    if (!config || typeof config !== "object" || !("links" in config)) continue;
    const { links, title: rawTitle } = config as { links?: unknown; title?: unknown };
    const title =
      typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : "Link List";
    if (links === undefined || links === null) continue;
    if (typeof links !== "string") {
      problems.push(`"${title}": the links must be text, one Label|URL per line.`);
      continue;
    }
    for (const l of widgetLinkLines(links)) {
      const check = checkWidgetLinkTarget(l.target);
      if (!check.ok) problems.push(`"${title}", line ${l.line}: the link ${check.reason}.`);
    }
  }
  return problems;
}

import type { NextRequest, NextResponse } from "next/server";

/**
 * Where someone goes after signing in: back to the page that sent them to sign
 * in. The proxy adds it to the sign-in page's address as `?next=`, and every
 * way of signing in (password, Google, Microsoft, an org's SSO) honours it.
 * Connecting a sign-in method (Profile, Sign-in methods) uses the same rule for
 * where it comes back to.
 *
 * It is client input: a link anyone can write. So it is only ever a page on
 * this site, checked by `safeReturnTo` wherever it is read or used, and
 * anything else lands on "/". This file imports nothing that runs on the
 * server, so the sign-in page uses the same check.
 */
export const RETURN_TO_PARAM = "next";

/** Carries the address across the provider's round trip, from start to callback. */
export const RETURN_TO_COOKIE = "signin_return";
const RETURN_TO_MAX_AGE_SECONDS = 10 * 60;
/**
 * The longest address the cookie keeps, counted as stored. A cookie is stored
 * encoded (a "/" takes three characters), and a browser drops a cookie past
 * 4096 bytes whole, so an address the rule accepts could otherwise be lost
 * without a trace. This keeps the cookie well under that limit.
 */
const RETURN_TO_COOKIE_MAX_CHARS = 2000;

const PLACEHOLDER = "http://return-to.invalid";

/**
 * A page on this site to go to, or "/". It must be an absolute path with a
 * single leading slash, with no backslash, whitespace or control character
 * anywhere: URL parsing drops tabs and newlines and reads a backslash as a
 * slash, so either can turn a path into another host's address. It is then
 * resolved the way a browser resolves it, dot segments included, and must
 * still be a path on this site. The sign-in page and API routes are refused,
 * however they are spelled: neither is somewhere to land after signing in.
 * The answer is the resolved address, so what was checked is what gets used.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048 || !/^\/(?![/\\])[^\s\\\x00-\x1f\x7f]*$/.test(raw)) {
    return "/";
  }
  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER);
  } catch {
    return "/";
  }
  const { pathname } = url;
  if (url.origin !== PLACEHOLDER || pathname.startsWith("//")) return "/";
  const plain = decodeEscapes(pathname).toLowerCase();
  if (isUnder(plain, "/login") || isUnder(plain, "/api")) return "/";
  return `${pathname}${url.search}${url.hash}`;
}

/** Each %XX escape as the character it stands for, one byte at a time: enough to compare with an ASCII name. */
function decodeEscapes(pathname: string): string {
  return pathname.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The path itself or below it, never a longer name that shares its prefix. */
function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The absolute address to land on, always on `origin`. */
export function landingUrl(origin: string, returnTo: unknown): URL {
  const url = new URL(safeReturnTo(returnTo), origin);
  return url.origin === new URL(origin).origin ? url : new URL("/", origin);
}

/** Query parameters a page's return address never carries: a credential can travel in them, and `_rsc` is Next's own. */
const NEVER_CARRIED = new Set(["token", "code", "state", "_rsc"]);

/**
 * The address of a page someone was sent away from to sign in: its path and
 * query as they were sent, less any parameter in NEVER_CARRIED, so a secret in
 * a link isn't copied into the sign-in page's address.
 */
export function pageReturnTo(pathname: string, search: string): string {
  const kept = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "" && !NEVER_CARRIED.has(paramName(pair)));
  return kept.length > 0 ? `${pathname}?${kept.join("&")}` : pathname;
}

/** A query pair's name, decoded and lower-cased, for comparing with NEVER_CARRIED. */
function paramName(pair: string): string {
  const raw = pair.split("=", 1)[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** A sign-in start link (`/api/auth/google`, say) that carries the return address, when there is one. */
export function withReturnTo(href: string, returnTo: unknown): string {
  const back = safeReturnTo(returnTo);
  if (back === "/") return href;
  return `${href}${href.includes("?") ? "&" : "?"}${RETURN_TO_PARAM}=${encodeURIComponent(back)}`;
}

/** The sign-in page, with an error to show, keeping the return address for the next try. */
export function loginUrl(origin: string, opts: { error?: string; returnTo?: unknown } = {}): URL {
  const url = new URL("/login", origin);
  if (opts.error) url.searchParams.set("error", opts.error);
  const back = safeReturnTo(opts.returnTo);
  if (back !== "/") url.searchParams.set(RETURN_TO_PARAM, back);
  return url;
}

/**
 * Where an org's SSO sign-in lands. That session opens this org and no other,
 * so it returns only to a page in this org; anything else goes to the org's home.
 */
export function ssoReturnTo(returnTo: unknown, orgSlug: string): string {
  const home = `/${encodeURIComponent(orgSlug)}`;
  const back = safeReturnTo(returnTo);
  return isUnder(new URL(back, PLACEHOLDER).pathname, home) ? back : home;
}

/**
 * The address as the cookie may hold it: the rule's answer, and only if it
 * fits once stored. The start and the callback both use this, so they can't
 * disagree about what is kept.
 */
function keepable(raw: unknown): string {
  const back = safeReturnTo(raw);
  return encodeURIComponent(back).length > RETURN_TO_COOKIE_MAX_CHARS ? "/" : back;
}

/**
 * At a sign-in start: keep this sign-in's return address for the callback, or
 * clear one left by an abandoned sign-in. An address too long to keep is not
 * kept, and that sign-in lands on "/".
 */
export function rememberReturnTo(response: NextResponse, request: NextRequest): void {
  const back = keepable(request.nextUrl.searchParams.get(RETURN_TO_PARAM));
  if (back === "/") {
    response.cookies.delete(RETURN_TO_COOKIE);
    return;
  }
  response.cookies.set(RETURN_TO_COOKIE, back, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: RETURN_TO_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
}

/** At a sign-in callback: the return address kept at the start, checked again. */
export function rememberedReturnTo(request: NextRequest): string {
  return keepable(request.cookies.get(RETURN_TO_COOKIE)?.value);
}

/**
 * Clears the kept address. A callback does this whatever its outcome (a
 * refused sign-in carries the address in the sign-in page's link instead), and
 * so does signing out.
 */
export function forgetReturnTo<T extends NextResponse>(response: T): T {
  response.cookies.delete(RETURN_TO_COOKIE);
  return response;
}

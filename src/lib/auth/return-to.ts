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

const PLACEHOLDER = "http://return-to.invalid";

/**
 * A page on this site to go to, or "/". It must be an absolute path with a
 * single leading slash, with no backslash, whitespace or control character
 * anywhere: URL parsing drops tabs and newlines and reads a backslash as a
 * slash, so either can turn a path into another host's address. It is then
 * resolved the way a browser resolves it, dot segments included, and must
 * still be a path on this site. The sign-in page and API routes are refused:
 * neither is somewhere to land after signing in. The answer is the resolved
 * address, so what was checked is what gets used.
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
  if (isUnder(pathname, "/login") || isUnder(pathname, "/api")) return "/";
  return `${pathname}${url.search}${url.hash}`;
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
 * At a sign-in start: keep this sign-in's return address for the callback, or
 * clear one left by an abandoned sign-in.
 */
export function rememberReturnTo(response: NextResponse, request: NextRequest): void {
  const back = safeReturnTo(request.nextUrl.searchParams.get(RETURN_TO_PARAM));
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
  return safeReturnTo(request.cookies.get(RETURN_TO_COOKIE)?.value);
}

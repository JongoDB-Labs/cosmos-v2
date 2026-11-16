// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  RETURN_TO_COOKIE,
  landingUrl,
  loginUrl,
  rememberReturnTo,
  pageReturnTo,
  rememberedReturnTo,
  safeReturnTo,
  ssoReturnTo,
  withReturnTo,
} from "./return-to";

describe("safeReturnTo", () => {
  it("keeps a page on this site, with its query and fragment", () => {
    expect(safeReturnTo("/acme/settings/profile")).toBe("/acme/settings/profile");
    expect(safeReturnTo("/a?b=c#d")).toBe("/a?b=c#d");
    expect(safeReturnTo("/acme/issues?view=list&q=a%20b")).toBe("/acme/issues?view=list&q=a%20b");
  });

  it("answers with the address a browser would actually go to", () => {
    expect(safeReturnTo("/acme/x/../issues")).toBe("/acme/issues");
  });

  // Every rejected shape gets its own case, so a rule that stops catching one
  // fails by name.
  it.each([
    ["another host", "https://elsewhere.example/acme"],
    ["another host over http", "http://elsewhere.example"],
    ["a host-relative address", "//elsewhere.example"],
    ["a host-relative address with a path", "//elsewhere.example/acme"],
    ["a backslash after the slash", "/\\elsewhere.example"],
    ["a leading backslash", "\\\\elsewhere.example"],
    ["a backslash later on", "/acme\\..\\..\\elsewhere.example"],
    ["a script scheme", "javascript:alert(1)"],
    ["a data scheme", "data:text/html,hello"],
    ["a scheme with no slashes", "https:elsewhere.example"],
    ["a tab the URL parser drops", "/\t/elsewhere.example"],
    ["a newline the URL parser drops", "/\n/elsewhere.example"],
    ["leading whitespace", " /acme"],
    ["a control character", "/acme\u0000"],
    ["a dot segment that resolves to a host-relative address", "/.//elsewhere.example"],
    ["a parent segment that resolves to a host-relative address", "/acme/..//elsewhere.example"],
    ["an encoded parent segment", "/%2e%2e//elsewhere.example"],
    ["a relative path", "acme/issues"],
    ["the sign-in page", "/login"],
    ["the sign-in page with its own return address", "/login?next=/acme"],
    ["an API route", "/api/auth/logout"],
    ["an API route behind a dot segment", "/./api/auth/logout"],
    ["an API route in capitals", "/API/auth/logout"],
    ["an API route with an encoded letter", "/%61pi/auth/logout"],
    ["the sign-in page in capitals", "/Login"],
    ["the sign-in page with an encoded letter", "/%6Cogin"],
    ["something far too long", `/${"a".repeat(2048)}`],
    ["an empty string", ""],
    ["nothing", null],
    ["not a string", 7],
  ])("refuses %s", (_shape, raw) => {
    expect(safeReturnTo(raw)).toBe("/");
  });

  it("positive control: the same probes accept the page they were built from", () => {
    // Each refused shape above names /acme or elsewhere.example; the rule
    // itself has no quarrel with either as an ordinary page.
    expect(safeReturnTo("/acme")).toBe("/acme");
    expect(safeReturnTo("/elsewhere.example")).toBe("/elsewhere.example");
    expect(safeReturnTo("/loginhelp")).toBe("/loginhelp");
    expect(safeReturnTo("/apis")).toBe("/apis");
    // An encoded letter elsewhere is left as it was sent.
    expect(safeReturnTo("/%41cme/issues")).toBe("/%41cme/issues");
  });
});

describe("pageReturnTo", () => {
  it("keeps the page's path and query as they were sent", () => {
    expect(pageReturnTo("/acme/issues", "?view=list&q=a%20b")).toBe("/acme/issues?view=list&q=a%20b");
    expect(pageReturnTo("/acme/issues", "")).toBe("/acme/issues");
  });

  it("leaves out parameters that can carry a credential, and Next's own", () => {
    expect(pageReturnTo("/acme/x", "?view=list&token=t1&code=c1&state=s1&_rsc=r1&q=1")).toBe("/acme/x?view=list&q=1");
    expect(pageReturnTo("/acme/x", "?Token=t1&%74oken=t2")).toBe("/acme/x");
    expect(pageReturnTo("/acme/x", "?token=t1")).toBe("/acme/x");
  });
});

describe("landingUrl", () => {
  it("is always on the origin it was given", () => {
    for (const raw of ["//elsewhere.example/x", "/\t/elsewhere.example", "/%2F/elsewhere.example", "/.//elsewhere.example"]) {
      expect(landingUrl("https://app.example", raw).origin).toBe("https://app.example");
    }
    expect(landingUrl("https://app.example", "/acme/issues?x=1").href).toBe("https://app.example/acme/issues?x=1");
  });
});

describe("withReturnTo", () => {
  it("carries a page to the sign-in start", () => {
    expect(withReturnTo("/api/auth/google", "/acme/issues?x=1")).toBe("/api/auth/google?next=%2Facme%2Fissues%3Fx%3D1");
    expect(withReturnTo("/api/auth/x?a=1", "/acme")).toBe("/api/auth/x?a=1&next=%2Facme");
  });

  it("adds nothing for the home page or a refused address", () => {
    expect(withReturnTo("/api/auth/google", "/")).toBe("/api/auth/google");
    expect(withReturnTo("/api/auth/google", "//elsewhere.example")).toBe("/api/auth/google");
  });
});

describe("loginUrl", () => {
  it("carries the error and the return address", () => {
    const url = loginUrl("https://app.example", { error: "rate_limited", returnTo: "/acme/issues?x=1" });
    expect(url.origin).toBe("https://app.example");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("rate_limited");
    expect(url.searchParams.get("next")).toBe("/acme/issues?x=1");
  });

  it("drops a refused return address", () => {
    const url = loginUrl("https://app.example", { returnTo: "//elsewhere.example" });
    expect(url.search).toBe("");
  });
});

describe("ssoReturnTo", () => {
  it("returns to a page in the org the session opens", () => {
    expect(ssoReturnTo("/acme/issues?x=1", "acme")).toBe("/acme/issues?x=1");
    expect(ssoReturnTo("/acme", "acme")).toBe("/acme");
  });

  it("lands on the org's home for anything else", () => {
    for (const raw of ["/other/issues", "/acme-other/issues", "/acme/../other", "/", "//elsewhere.example", undefined]) {
      expect(ssoReturnTo(raw, "acme")).toBe("/acme");
    }
  });
});

describe("the return address across the provider round trip", () => {
  const start = (search: string) => new NextRequest(`http://localhost/api/auth/google${search}`);
  afterEach(() => vi.unstubAllEnvs());

  it("is kept in a cookie when the sign-in starts", () => {
    const res = NextResponse.redirect("https://idp.example/authorize");
    rememberReturnTo(res, start("?next=%2Facme%2Fissues%3Fx%3D1"));
    const cookie = res.cookies.get(RETURN_TO_COOKIE);
    expect(cookie?.value).toBe("/acme/issues?x=1");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(600);
    expect(cookie?.secure).toBe(false);
  });

  it("is a secure cookie in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = NextResponse.redirect("https://idp.example/authorize");
    rememberReturnTo(res, start("?next=%2Facme"));
    expect(res.cookies.get(RETURN_TO_COOKIE)?.secure).toBe(true);
    expect(res.headers.get("set-cookie")).toMatch(/; Secure/i);
  });

  it("clears an earlier one when this sign-in has none, or one that is refused", () => {
    for (const search of ["", "?next=%2F%2Felsewhere.example"]) {
      const res = NextResponse.redirect("https://idp.example/authorize");
      rememberReturnTo(res, start(search));
      // A delete is a Set-Cookie that expires it.
      expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
      expect(res.headers.get("set-cookie")).toMatch(/signin_return=;.*Expires=Thu, 01 Jan 1970/);
    }
  });

  it("keeps nothing when the address is too long for the cookie, so the sign-in lands on /", () => {
    // The address is stored encoded, and a "/" is stored as three characters.
    // This one is within the rule's length but stored as 4,095: past the
    // browser's cookie limit, which drops the whole cookie.
    const long = `/${"a/".repeat(1023)}`;
    expect(safeReturnTo(long)).toBe(long);
    const res = NextResponse.redirect("https://idp.example/authorize");
    rememberReturnTo(res, start(`?next=${encodeURIComponent(long)}`));
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
    expect(res.headers.get("set-cookie")).toMatch(/signin_return=;.*Expires=Thu, 01 Jan 1970/);
  });

  it("measures what is stored, not what was typed", () => {
    // Short as typed, and accepted by the rule, but six times longer once
    // resolved: each "ä" becomes %C3%A4.
    const wide = `/${"ä".repeat(2047)}`;
    expect(safeReturnTo(wide)).toHaveLength(12_283);
    const res = NextResponse.redirect("https://idp.example/authorize");
    rememberReturnTo(res, start(`?next=${encodeURIComponent(wide)}`));
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
  });

  it("is held to the same limit when it is read back at the callback", () => {
    const callback = (value: string) =>
      new NextRequest("http://localhost/api/auth/google/callback", {
        headers: { cookie: `${RETURN_TO_COOKIE}=${encodeURIComponent(value)}` },
      });
    const fits = `/${"a".repeat(1997)}`;
    expect(rememberedReturnTo(callback(fits))).toBe(fits);
    expect(rememberedReturnTo(callback(`${fits}a`))).toBe("/");
  });

  it("keeps the longest address that fits, well under the browser's cookie limit", () => {
    const fits = `/${"a".repeat(1997)}`;
    expect(encodeURIComponent(fits)).toHaveLength(2000);
    const kept = NextResponse.redirect("https://idp.example/authorize");
    rememberReturnTo(kept, start(`?next=${encodeURIComponent(fits)}`));
    expect(kept.cookies.get(RETURN_TO_COOKIE)?.value).toBe(fits);
    expect(kept.headers.get("set-cookie")!.length).toBeLessThan(4096);

    const over = NextResponse.redirect("https://idp.example/authorize");
    rememberReturnTo(over, start(`?next=${encodeURIComponent(`${fits}a`)}`));
    expect(over.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
  });

  it("is read back, and checked again, at the callback", () => {
    const callback = (value: string) =>
      new NextRequest("http://localhost/api/auth/google/callback", {
        headers: { cookie: `${RETURN_TO_COOKIE}=${encodeURIComponent(value)}` },
      });
    expect(rememberedReturnTo(callback("/acme/issues?x=1"))).toBe("/acme/issues?x=1");
    expect(rememberedReturnTo(callback("//elsewhere.example"))).toBe("/");
    expect(rememberedReturnTo(new NextRequest("http://localhost/api/auth/google/callback"))).toBe("/");
  });
});

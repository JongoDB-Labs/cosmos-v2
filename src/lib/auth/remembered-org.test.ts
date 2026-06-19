// @vitest-environment node
import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { REMEMBERED_ORG_COOKIE, setRememberedOrgCookie } from "./remembered-org";

describe("remembered-org cookie", () => {
  it("uses the expected cookie name", () => {
    expect(REMEMBERED_ORG_COOKIE).toBe("org");
  });

  it("sets a non-httpOnly, 1-year, lax, path=/ cookie", () => {
    const res = NextResponse.json({ ok: true });
    setRememberedOrgCookie(res, "acme");
    const c = res.cookies.get(REMEMBERED_ORG_COOKIE);
    expect(c?.value).toBe("acme");
    expect(c?.httpOnly).toBe(false);
    expect(c?.sameSite).toBe("lax");
    expect(c?.path).toBe("/");
    expect(c?.maxAge).toBe(60 * 60 * 24 * 365);
  });

  it("is a no-op for an empty slug", () => {
    const res = NextResponse.json({ ok: true });
    setRememberedOrgCookie(res, "");
    expect(res.cookies.get(REMEMBERED_ORG_COOKIE)).toBeUndefined();
  });
});

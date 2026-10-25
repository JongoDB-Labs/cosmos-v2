// The Accounting section index is a pure redirect to its first child. It used
// to open a session + DB read (`getAuthContext`) and bounce to "/" when that
// came back empty — a gate that gated nothing, because the destination
// (accounting/finance/page.tsx) performs the identical check and then its own
// `canViewPage` check on top. An unauthenticated caller therefore ended up on
// "/" either way; the only difference was an extra round-trip on the way.
//
// This pins the shape: the index resolves the destination and nothing else.
import { describe, it, expect, vi, beforeEach } from "vitest";

class RedirectError extends Error {
  constructor(readonly url: string) {
    super("NEXT_REDIRECT");
  }
}

// The real `redirect()` throws to unwind the render — mirror that, otherwise a
// page with two sequential redirects looks like it only took the last one.
const redirect = vi.fn((url: string): never => {
  throw new RedirectError(url);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

const getAuthContext = vi.fn(async () => null);
vi.mock("@/lib/auth/session", () => ({
  getAuthContext: () => getAuthContext(),
}));

import AccountingIndexPage from "./page";

beforeEach(() => {
  redirect.mockClear();
  getAuthContext.mockClear();
});

describe("Accounting section index", () => {
  it("lands on Finance without reading the session", async () => {
    await expect(
      AccountingIndexPage({ params: Promise.resolve({ orgSlug: "acme" }) }),
    ).rejects.toBeInstanceOf(RedirectError);

    // Exactly one hop, straight to the section default. With the old auth
    // guard in place this fires with "/" instead — the caller has no session.
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/acme/accounting/finance");
    expect(getAuthContext).not.toHaveBeenCalled();
  });
});
